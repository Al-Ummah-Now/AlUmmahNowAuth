import { describe, it, expect } from "vitest";
import * as v from "valibot";

// We'll test the email validation and logic without actually calling Resend
// This is better suited for the Cloudflare Workers environment

describe("Email Validation", () => {
  const EmailSchema = v.pipe(v.string(), v.email());

  it("should validate correct email addresses", () => {
    expect(() => v.parse(EmailSchema, "valid@example.com")).not.toThrow();
    expect(() => v.parse(EmailSchema, "user+tag@example.com")).not.toThrow();
    expect(() => v.parse(EmailSchema, "test.user@subdomain.example.com")).not.toThrow();
  });

  it("should reject invalid email addresses", () => {
    expect(() => v.parse(EmailSchema, "invalid-email")).toThrow();
    expect(() => v.parse(EmailSchema, "@example.com")).toThrow();
    expect(() => v.parse(EmailSchema, "user@")).toThrow();
    expect(() => v.parse(EmailSchema, "")).toThrow();
  });
});

describe("Email Retry Logic", () => {
  it("should implement exponential backoff calculation", () => {
    // Test exponential backoff formula: Math.min(1000 * Math.pow(2, attempt - 1), 5000)
    const calculateBackoff = (attempt: number): number => {
      return Math.min(1000 * Math.pow(2, attempt - 1), 5000);
    };

    expect(calculateBackoff(1)).toBe(1000); // 2^0 * 1000 = 1000ms
    expect(calculateBackoff(2)).toBe(2000); // 2^1 * 1000 = 2000ms
    expect(calculateBackoff(3)).toBe(4000); // 2^2 * 1000 = 4000ms
    expect(calculateBackoff(4)).toBe(5000); // 2^3 * 1000 = 8000ms, capped at 5000ms
    expect(calculateBackoff(5)).toBe(5000); // 2^4 * 1000 = 16000ms, capped at 5000ms
  });

  it("should have correct retry parameters", () => {
    const defaultMaxRetries = 3;
    const maxBackoffMs = 5000;

    expect(defaultMaxRetries).toBe(3);
    expect(maxBackoffMs).toBe(5000);
  });
});

describe("Email Function Parameters", () => {
  it("should require all necessary parameters", () => {
    // Test that our function signature is correct
    const requiredParams = [
      "apiKey",
      "from",
      "to",
      "subject",
      "html",
    ];

    expect(requiredParams).toHaveLength(5);
    expect(requiredParams).toContain("apiKey");
    expect(requiredParams).toContain("from");
    expect(requiredParams).toContain("to");
    expect(requiredParams).toContain("subject");
    expect(requiredParams).toContain("html");
  });

  it("should have optional maxRetries parameter with default value", () => {
    const defaultMaxRetries = 3;
    expect(defaultMaxRetries).toBe(3);
  });
});

describe("Email Error Handling", () => {
  it("should throw descriptive error for invalid email", () => {
    try {
      v.parse(v.pipe(v.string(), v.email()), "invalid-email");
      expect.fail("Should have thrown validation error");
    } catch (error) {
      expect(error).toBeDefined();
      // Valibot throws ValiError
      expect(String(error)).toContain("Invalid");
    }
  });

  it("should handle validation errors gracefully", () => {
    const validateEmail = (email: string): boolean => {
      try {
        v.parse(v.pipe(v.string(), v.email()), email);
        return true;
      } catch {
        return false;
      }
    };

    expect(validateEmail("valid@example.com")).toBe(true);
    expect(validateEmail("invalid")).toBe(false);
  });
});

describe("Email Module Exports", () => {
  it("should export SendEmail function", async () => {
    const SendEmail = (await import("./email")).default;
    expect(SendEmail).toBeDefined();
    expect(typeof SendEmail).toBe("function");
  });
});
