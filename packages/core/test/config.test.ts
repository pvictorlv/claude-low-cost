import { describe, expect, it } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG, isLoopbackUrl } from "../src/config.js";

describe("NDA guard: isLoopbackUrl", () => {
  it.each(["http://127.0.0.1:8081", "http://localhost:8080/v1", "http://[::1]:9000", "http://127.0.0.42"])(
    "accepts %s",
    (url) => expect(isLoopbackUrl(url)).toBe(true),
  );

  it.each([
    "http://10.0.0.5:8081",
    "https://api.openrouter.ai",
    "http://localhost.evil.com",
    "http://127.0.0.1.nip.io",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", (url) => expect(isLoopbackUrl(url)).toBe(false));
});

describe("ConfigSchema", () => {
  it("accepts the default config", () => {
    expect(ConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it("refuses a non-loopback model endpoint", () => {
    const bad = { ...DEFAULT_CONFIG, judge: { ...DEFAULT_CONFIG.judge, baseUrl: "https://example.com" } };
    expect(() => ConfigSchema.parse(bad)).toThrow(/loopback/);
  });
});
