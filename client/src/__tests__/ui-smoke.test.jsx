import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

function SmokeCard({ title, value }) {
  return (
    <section>
      <h2>{title}</h2>
      <p>{value}</p>
    </section>
  );
}

describe("testing-library smoke setup", () => {
  it("renders and queries DOM content", () => {
    render(<SmokeCard title="Realtime Stock Charts" value="Live" />);
    expect(screen.getByRole("heading", { name: "Realtime Stock Charts" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
});
