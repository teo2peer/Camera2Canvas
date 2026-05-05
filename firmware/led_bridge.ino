// WS2812B serial bridge. Protocol:
//   0xAA 0x55 <u16 N big-endian> <RGB * N> <u8 xor checksum over RGB bytes>
// Idle when no frame within IDLE_MS: gentle breathing on first LED.

#include <FastLED.h>

#define LED_PIN     6
#define BTN_PIN     2          // capture button (active LOW, INPUT_PULLUP)
#define MAX_LEDS    600
#define BAUD        921600
#define IDLE_MS     1500
#define DEBOUNCE_MS 40

CRGB leds[MAX_LEDS];
uint16_t ledCount = 300;
uint8_t buf[MAX_LEDS * 3];

unsigned long lastFrame = 0;

bool readBytes(uint8_t *dst, size_t n, unsigned long timeoutMs = 200) {
  unsigned long start = millis();
  size_t got = 0;
  while (got < n) {
    if (Serial.available()) {
      dst[got++] = Serial.read();
    } else if (millis() - start > timeoutMs) {
      return false;
    }
  }
  return true;
}

uint8_t btnState = HIGH;
uint8_t btnLast = HIGH;
unsigned long btnLastChange = 0;

void setup() {
  Serial.begin(BAUD);
  pinMode(BTN_PIN, INPUT_PULLUP);
  FastLED.addLeds<WS2812B, LED_PIN, GRB>(leds, MAX_LEDS);
  FastLED.setBrightness(180);
  FastLED.clear(true);
}

void pollButton() {
  uint8_t r = digitalRead(BTN_PIN);
  if (r != btnLast) {
    btnLastChange = millis();
    btnLast = r;
  }
  if (millis() - btnLastChange > DEBOUNCE_MS && r != btnState) {
    btnState = r;
    if (btnState == LOW) {
      Serial.println("BTN");  // pressed (active low)
    }
  }
}

void loop() {
  pollButton();
  // sync header
  if (!Serial.available()) {
    if (millis() - lastFrame > IDLE_MS) idleAnim();
    return;
  }
  if (Serial.read() != 0xAA) return;
  uint8_t b;
  if (!readBytes(&b, 1) || b != 0x55) return;

  uint8_t hi, lo;
  if (!readBytes(&hi, 1) || !readBytes(&lo, 1)) return;
  uint16_t n = (uint16_t(hi) << 8) | lo;
  if (n == 0 || n > MAX_LEDS) return;

  if (!readBytes(buf, n * 3, 500)) return;

  uint8_t chk;
  if (!readBytes(&chk, 1)) return;
  uint8_t calc = 0;
  for (uint16_t i = 0; i < n * 3; i++) calc ^= buf[i];
  if (calc != chk) return;

  ledCount = n;
  for (uint16_t i = 0; i < n; i++) {
    leds[i] = CRGB(buf[i*3], buf[i*3+1], buf[i*3+2]);
  }
  for (uint16_t i = n; i < MAX_LEDS; i++) leds[i] = CRGB::Black;
  FastLED.show();
  lastFrame = millis();
}

void idleAnim() {
  static uint8_t hue = 0;
  static unsigned long last = 0;
  if (millis() - last < 30) return;
  last = millis();
  hue++;
  uint8_t v = (sin8(hue) * 60) >> 8;
  for (uint16_t i = 0; i < MAX_LEDS; i++) {
    leds[i] = CHSV(hue + i, 200, v);
  }
  FastLED.show();
}
