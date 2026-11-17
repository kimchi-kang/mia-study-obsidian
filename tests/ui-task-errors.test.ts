import { describe, expect, it, vi } from "vitest";
import { reportUiFailure } from "../src/ui/error-message";

describe("synchronous UI task boundary", () => {
  it("observes a host rejection and reports the original error without rethrowing", async () => {
    const error = new Error("host leaf failed");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(reportUiFailure(Promise.reject(error))).toBeUndefined();
      await Promise.resolve();
      expect(report).toHaveBeenCalledExactlyOnceWith(error);
    } finally { report.mockRestore(); }
  });
  it("leaves successful task completion silent", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reportUiFailure(Promise.resolve()); await Promise.resolve();
      expect(report).not.toHaveBeenCalled();
    } finally { report.mockRestore(); }
  });
});
