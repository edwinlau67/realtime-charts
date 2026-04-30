import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SourceChip from "../components/SourceChip.jsx";

describe("SourceChip", () => {
  it("renders normal source chip with status and count", () => {
    render(
      <SourceChip
        id="yahoo"
        label="Yahoo"
        count={9}
        color="#7e22ce"
        status="live"
        title="Yahoo Finance"
      />
    );

    expect(screen.getByTestId("source-chip-yahoo")).toHaveTextContent("Yahoo");
    expect(screen.getByTestId("source-chip-yahoo")).toHaveTextContent("9");
    expect(screen.getByTitle("Yahoo Finance")).toBeInTheDocument();
    expect(document.querySelector(".src-status-live")).toBeTruthy();
  });

  it("renders all chip without status indicator and handles click", () => {
    const onClick = vi.fn();
    render(
      <SourceChip
        id="all"
        all
        label="All"
        count={26}
        active
        onClick={onClick}
      />
    );

    const chip = screen.getByTestId("source-chip-all");
    expect(chip.className).toContain("all");
    expect(chip.className).toContain("active");
    expect(chip.querySelector(".src-status")).toBeNull();
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
