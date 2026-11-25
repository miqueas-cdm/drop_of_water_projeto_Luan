/*
  Drop of Water ESP32 example
  Requires ArduinoJson (v7) and the ESP32 Arduino core.
  Configure Wi-Fi, device ID, and the one-time device key before uploading.
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>

const char *WIFI_SSID = "YOUR_WIFI";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
#define API_BASE "https://dropofwater.miqtav.com/api/v1"
const char *URL_POST_LEITURAS = API_BASE "/device/telemetry";
const char *URL_GET_COMANDO = API_BASE "/device/commands";
const char *DEVICE_ID = "YOUR_DEVICE_ID";
const char *DEVICE_KEY = "PASTE_DEVICE_KEY_ONCE";
const bool USE_POST_TELEMETRY = false;
const bool USE_UNAUTHENTICATED_TEST_ACCESS = false;

const unsigned long HTTP_TIMEOUT_MS = 15000;
const unsigned int MAX_RETRIES = 3;
const unsigned long DEVICE_REQUEST_GAP_MS = 1100;

// Paste the certificate chain's root CA here for production.
static const char ROOT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_THE_TRUSTED_ROOT_CA_HERE
-----END CERTIFICATE-----
)EOF";

WiFiClientSecure secureClient;
unsigned int intervalSeconds = 60;

String makeNonce() {
  char nonce[65];
  for (int i = 0; i < 8; i++) {
    snprintf(nonce + (i * 8), 9, "%08lx", (unsigned long)esp_random());
  }
  return String(nonce);
}

bool synchronizeClock() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  struct tm timeInfo;
  for (int attempt = 0; attempt < 30; attempt++) {
    if (getLocalTime(&timeInfo, 500)) return true;
    delay(500);
  }
  Serial.println("NTP synchronization failed.");
  return false;
}

int requestOnce(const String &url, const char *method, const String &body, String &responseBody) {
  HTTPClient http;
  String requestUrl = url;
  if (USE_UNAUTHENTICATED_TEST_ACCESS) {
    requestUrl += (requestUrl.indexOf('?') >= 0 ? "&dispositivo_id=" : "?dispositivo_id=");
    requestUrl += DEVICE_ID;
  }
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);

  if (!http.begin(secureClient, requestUrl)) {
    Serial.println("Unable to start HTTPS request.");
    return -1;
  }
  if (!USE_UNAUTHENTICATED_TEST_ACCESS) {
    http.addHeader("X-Device-Id", DEVICE_ID);
    http.addHeader("X-Device-Key", DEVICE_KEY);
  }
  if (strcmp(method, "POST") == 0) http.addHeader("Content-Type", "application/json");

  int status = strcmp(method, "POST") == 0 ? http.POST(body) : http.GET();
  responseBody = status > 0 ? http.getString() : "";
  http.end();
  return status;
}

int requestWithRetry(const String &url, const char *method, const String &body, String &responseBody) {
  for (unsigned int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    int status = requestOnce(url, method, body, responseBody);
    if (status >= 200 && status < 300) return status;
    Serial.printf("Request failed (HTTP %d), attempt %u/%u.\n", status, attempt, MAX_RETRIES);
    if (attempt < MAX_RETRIES) delay(1200);
  }
  return -1;
}

bool sendReading(float temperature, float humidity, float battery) {
  String response;
  int status;
  if (USE_POST_TELEMETRY) {
    String body = "{\"temp\":" + String(temperature, 1)
      + ",\"hum\":" + String(humidity, 1)
      + ",\"bat\":" + String(battery, 1) + "}";
    status = requestWithRetry(URL_POST_LEITURAS, "POST", body, response);
  } else {
    // Generate a fresh timestamp and nonce for each retry, never put the device key in a URL.
    status = -1;
    for (unsigned int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      time_t now;
      time(&now);
      String url = String(API_BASE) + "/device/ingest?temp=" + String(temperature, 1)
        + "&hum=" + String(humidity, 1)
        + "&bat=" + String(battery, 1)
        + "&ts=" + String((unsigned long)now)
        + "&nonce=" + makeNonce();
      status = requestOnce(url, "GET", "", response);
      if (status >= 200 && status < 300) break;
      if (attempt < MAX_RETRIES) delay(1200);
    }
  }

  if (status < 200 || status >= 300) return false;
  Serial.printf("Telemetry accepted (HTTP %d): %s\n", status, response.c_str());
  return true;
}

bool readConfig() {
  String response;
  if (requestWithRetry(String(API_BASE) + "/device/config", "GET", "", response) < 200) return false;

  JsonDocument config;
  if (deserializeJson(config, response)) {
    Serial.println("Invalid config response.");
    return false;
  }
  intervalSeconds = max(1U, config["interval_sec"] | 60U);
  Serial.printf("Next interval: %u seconds.\n", intervalSeconds);
  return true;
}

void checkCommands() {
  String response;
  if (requestWithRetry(URL_GET_COMANDO, "GET", "", response) < 200) return;

  JsonDocument data;
  if (deserializeJson(data, response)) {
    Serial.println("Invalid commands response.");
    return;
  }
  JsonArray commands = data["commands"].as<JsonArray>();
  for (JsonObject command : commands) {
    unsigned long id = command["id"] | 0UL;
    const char *text = command["command"] | "";
    Serial.printf("Command %lu: %s\n", id, text);

    // Apply the supported command here before acknowledging it.
    delay(DEVICE_REQUEST_GAP_MS);
    String ackResponse;
    String ackUrl = String(API_BASE) + "/device/commands/ack?id=" + String(id) + "&status=done";
    requestWithRetry(ackUrl, "GET", "", ackResponse);
    delay(DEVICE_REQUEST_GAP_MS);
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  // TEST ONLY: disables certificate verification and exposes the connection to interception.
  // secureClient.setInsecure();
  // PRODUCTION: replace ROOT_CA with the CA certificate that validates your HTTPS server.
  secureClient.setCACert(ROOT_CA);

  synchronizeClock();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(5000);
    return;
  }
  if (!synchronizeClock()) {
    delay(HTTP_TIMEOUT_MS);
    return;
  }

  float temperature = 18.0f + (float)random(0, 120) / 10.0f;
  float humidity = 35.0f + (float)random(0, 450) / 10.0f;
  float battery = 60.0f + (float)random(0, 400) / 10.0f;
  sendReading(temperature, humidity, battery);
  delay(DEVICE_REQUEST_GAP_MS);
  if (!USE_UNAUTHENTICATED_TEST_ACCESS) {
    readConfig();
    delay(DEVICE_REQUEST_GAP_MS);
  }
  checkCommands();
  delay((unsigned long)intervalSeconds * 1000UL);
}
