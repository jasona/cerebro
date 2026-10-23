import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, cn, EmptyState, Input, Select, StatusPill, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "./index";

describe("cn", () => {
  it("joins truthy classes", () => {
    expect(cn("a", false, null, ["b", { c: true, d: false }], undefined)).toBe("a b c");
  });
});

describe("fields", () => {
  it("associate labels, hints and errors with the control", () => {
    const out = renderToString(<Input id="title" label="Title" hint="Shown to readers" error="Required" required />);
    expect(out).toContain('for="title"');
    expect(out).toContain('id="title"');
    expect(out).toContain('aria-describedby="title-hint title-error"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain("(required)");
  });

  it("textarea and select are labelled", () => {
    expect(renderToString(<Textarea id="sum" label="Summary" />)).toContain('for="sum"');
    const sel = renderToString(<Select id="team" label="Team" options={[{ value: "p", label: "Platform" }]} />);
    expect(sel).toContain('for="team"');
    expect(sel).toContain("Platform");
  });
});

describe("primitives", () => {
  it("Button defaults to type=button", () => {
    expect(renderToString(<Button>Go</Button>)).toContain('type="button"');
  });

  it("StatusPill conveys status in text", () => {
    expect(renderToString(<StatusPill status="withdrawn" />)).toContain("Withdrawn");
  });

  it("EmptyState renders heading and action", () => {
    const out = renderToString(<EmptyState title="No drafts yet" action={<Button>New brief</Button>} />);
    expect(out).toContain("<h2");
    expect(out).toContain("New brief");
  });

  it("Tabs render accessible roles", () => {
    const out = renderToString(
      <Tabs defaultValue="ask">
        <TabsList aria-label="Explore">
          <TabsTrigger value="ask">Ask</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
        </TabsList>
        <TabsContent value="ask">A</TabsContent>
        <TabsContent value="evidence">E</TabsContent>
      </Tabs>,
    );
    expect(out).toContain('role="tablist"');
    expect(out).toContain('role="tab"');
    expect(out).toContain('aria-selected="true"');
  });
});
