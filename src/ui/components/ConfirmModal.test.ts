import { describe, expect, it, vi } from "vitest";
import { handleConfirmKey } from "./confirmModalLogic.js";

function makeCallbacks() {
  return {
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };
}

describe("handleConfirmKey", () => {
  describe("Escape key — always cancels", () => {
    it("calls onCancel and does not call onConfirm when selection is No (default)", () => {
      const cb = makeCallbacks();
      handleConfirmKey({ name: "escape" }, 0, cb);
      expect(cb.onCancel).toHaveBeenCalledOnce();
      expect(cb.onConfirm).not.toHaveBeenCalled();
    });

    it("calls onCancel even when selection is Yes", () => {
      const cb = makeCallbacks();
      handleConfirmKey({ name: "escape" }, 1, cb);
      expect(cb.onCancel).toHaveBeenCalledOnce();
      expect(cb.onConfirm).not.toHaveBeenCalled();
    });
  });

  describe("'n' key — always cancels", () => {
    it("calls onCancel and does not call onConfirm", () => {
      const cb = makeCallbacks();
      handleConfirmKey({ name: "n" }, 0, cb);
      expect(cb.onCancel).toHaveBeenCalledOnce();
      expect(cb.onConfirm).not.toHaveBeenCalled();
    });
  });

  describe("'y' key — always confirms", () => {
    it("calls onConfirm regardless of current selection", () => {
      const cb = makeCallbacks();
      handleConfirmKey({ name: "y" }, 0, cb);
      expect(cb.onConfirm).toHaveBeenCalledOnce();
      expect(cb.onCancel).not.toHaveBeenCalled();
    });

    it("calls onConfirm even when selection is already Yes", () => {
      const cb = makeCallbacks();
      handleConfirmKey({ name: "y" }, 1, cb);
      expect(cb.onConfirm).toHaveBeenCalledOnce();
      expect(cb.onCancel).not.toHaveBeenCalled();
    });
  });

  describe("Enter key — confirms the current selection", () => {
    it("calls onCancel when selection is No (0)", () => {
      const cb = makeCallbacks();
      handleConfirmKey({ name: "return" }, 0, cb);
      expect(cb.onCancel).toHaveBeenCalledOnce();
      expect(cb.onConfirm).not.toHaveBeenCalled();
    });

    it("calls onConfirm when selection is Yes (1)", () => {
      const cb = makeCallbacks();
      handleConfirmKey({ name: "return" }, 1, cb);
      expect(cb.onConfirm).toHaveBeenCalledOnce();
      expect(cb.onCancel).not.toHaveBeenCalled();
    });
  });

  describe("default selection is No — Enter without moving should cancel", () => {
    it("Enter with initial state (0=No) calls onCancel", () => {
      const cb = makeCallbacks();
      // Simulate user pressing Enter immediately without navigating (selected=0)
      const next = handleConfirmKey({ name: "return" }, 0, cb);
      expect(next).toBe(0);
      expect(cb.onCancel).toHaveBeenCalledOnce();
      expect(cb.onConfirm).not.toHaveBeenCalled();
    });
  });

  describe("navigation keys — change selection without triggering action", () => {
    it("right arrow moves selection to Yes (1)", () => {
      const cb = makeCallbacks();
      const next = handleConfirmKey({ name: "right" }, 0, cb);
      expect(next).toBe(1);
      expect(cb.onConfirm).not.toHaveBeenCalled();
      expect(cb.onCancel).not.toHaveBeenCalled();
    });

    it("left arrow moves selection to No (0)", () => {
      const cb = makeCallbacks();
      const next = handleConfirmKey({ name: "left" }, 1, cb);
      expect(next).toBe(0);
      expect(cb.onConfirm).not.toHaveBeenCalled();
      expect(cb.onCancel).not.toHaveBeenCalled();
    });

    it("'l' key moves selection to Yes (1)", () => {
      const cb = makeCallbacks();
      const next = handleConfirmKey({ name: "l" }, 0, cb);
      expect(next).toBe(1);
    });

    it("'h' key moves selection to No (0)", () => {
      const cb = makeCallbacks();
      const next = handleConfirmKey({ name: "h" }, 1, cb);
      expect(next).toBe(0);
    });
  });

  describe("full interaction flow", () => {
    it("navigate to Yes then confirm with Enter", () => {
      const cb = makeCallbacks();
      let selected: 0 | 1 = 0;
      // Move right to Yes
      selected = handleConfirmKey({ name: "right" }, selected, cb);
      expect(selected).toBe(1);
      // Press Enter → should confirm
      handleConfirmKey({ name: "return" }, selected, cb);
      expect(cb.onConfirm).toHaveBeenCalledOnce();
      expect(cb.onCancel).not.toHaveBeenCalled();
    });

    it("navigate to Yes then press Escape — should cancel despite selection", () => {
      const cb = makeCallbacks();
      let selected: 0 | 1 = 0;
      selected = handleConfirmKey({ name: "l" }, selected, cb); // move to Yes
      expect(selected).toBe(1);
      handleConfirmKey({ name: "escape" }, selected, cb);
      expect(cb.onCancel).toHaveBeenCalledOnce();
      expect(cb.onConfirm).not.toHaveBeenCalled();
    });
  });

  describe("unrecognized keys — no action, no selection change", () => {
    it("ignores unrecognized key names", () => {
      const cb = makeCallbacks();
      const next = handleConfirmKey({ name: "up" }, 0, cb);
      expect(next).toBe(0);
      expect(cb.onConfirm).not.toHaveBeenCalled();
      expect(cb.onCancel).not.toHaveBeenCalled();
    });
  });
});
