import { PublishedBriefingDocument, type BriefingDocumentInput } from "@cerebro/briefing-schema/client";

/** Local published-shape strategy briefing for renderer tests (mirrors the reader concept; has bar and line charts). */
export const localStrategyInput: BriefingDocumentInput = {
  schemaVersion: 1,
  title: "Growth strategy",
  kind: "strategy",
  position: {
    headline: "Our next chapter: a focused move upmarket.",
    summary: "Win larger customers by focusing our product, sales motion, and service model on the **mid-market**.",
  },
  context: {
    stakes: "Our strongest retention and expansion come from customers with 100–1,000 employees.",
    background: "We have grown through self-serve adoption. See the [cohort review](https://example.com/cohorts).",
  },
  request: {
    type: "decision",
    statement: "Approve a 90-day mid-market pilot.",
    detail: "A focused team. A defined investment. Clear stop-or-scale criteria.",
    dueDate: "2026-11-05",
  },
  sections: [
    {
      id: "sec_recommendation",
      title: "The recommendation",
      blocks: [
        {
          id: "blk_rec_text",
          type: "narrative",
          text: "Mid-market combines stronger expansion with a shorter path to value.",
          evidenceRefs: [{ evidenceId: "ev_cohort" }],
        },
        {
          id: "blk_rec_decision",
          type: "decision",
          statement: "Where we focus next",
          options: [
            { id: "itm_opt_mid", label: "Mid-market pilot", chosen: true },
            { id: "itm_opt_ent", label: "Enterprise motion now", description: "Higher cost, longer cycles." },
          ],
          rationale: "The pilot tests the advantage _before_ we commit.",
        },
      ],
    },
    {
      id: "sec_why_now",
      title: "Why now",
      blocks: [
        {
          id: "blk_nrr_chart",
          type: "chart",
          title: "Net revenue retention by segment",
          kind: "bar",
          unit: "%",
          series: [
            {
              label: "NRR",
              points: [
                { x: "Small business", y: 96 },
                { x: "Mid-market", y: 124 },
                { x: "Enterprise", y: 112 },
              ],
            },
          ],
          altText: "Mid-market has the highest net revenue retention at 124%, ahead of enterprise at 112% and small business at 96%.",
          caption: "Illustrative cohort data · Q3 2026",
          evidenceRefs: [{ evidenceId: "ev_cohort" }],
        },
        { id: "blk_nrr_metric", type: "metric", label: "Mid-market NRR", value: 124, unit: "%", asOf: "2026-09", comparison: { label: "Enterprise", value: 112 } },
      ],
    },
    {
      id: "sec_tradeoffs",
      title: "Tradeoffs",
      blocks: [
        {
          id: "blk_compare",
          type: "comparison",
          title: "Segment comparison",
          columns: ["Time to value", "Implementation"],
          rows: [
            { label: "Mid-market", cells: ["6 weeks", "Low"] },
            { label: "Enterprise", cells: ["5 months", "High"] },
          ],
          evidenceRefs: [{ evidenceId: "ev_impl" }],
        },
        { id: "blk_risk", type: "risk", kind: "tradeoff", statement: "We defer enterprise features for two quarters.", impact: "medium" },
        { id: "blk_trend", type: "chart", title: "NRR trend", kind: "line", unit: "%", series: [
          { label: "Mid-market", points: [{ x: "Q1", y: 115 }, { x: "Q2", y: 119 }, { x: "Q3", y: 124 }] },
          { label: "Enterprise", points: [{ x: "Q1", y: 110 }, { x: "Q2", y: 111 }, { x: "Q3", y: 112 }] },
        ], altText: "Mid-market NRR rose from 115% to 124% across Q1–Q3; enterprise stayed near 111%." },
      ],
    },
    {
      id: "sec_next",
      title: "Next steps",
      blocks: [
        {
          id: "blk_timeline",
          type: "timeline",
          title: "Pilot plan",
          items: [
            { id: "itm_tl01", label: "Form pilot team", date: "2026-11" },
            { id: "itm_tl02", label: "Stop-or-scale review", date: "2027-02-10" },
          ],
        },
        { id: "blk_action", type: "action", statement: "Staff the pilot team", owner: "Maya Chen", dueDate: "2026-11-15" },
      ],
    },
  ],
  perspectives: [
    {
      id: "psp_finance",
      label: "Finance",
      audience: "Finance leadership",
      summary: "The pilot is a bounded investment with explicit stop criteria.",
      emphasis: ["sec_tradeoffs"],
      implications: [{ id: "itm_imp1", text: "Budget is capped for 90 days.", blockIds: ["blk_compare"] }],
    },
  ],
  evidence: [
    {
      id: "ev_cohort",
      title: "Customer cohort analysis",
      excerpt: "Mid-market cohorts show 124% net revenue retention.",
      attribution: "Q3 2026 customer cohort analysis",
      locator: "Page 8",
    },
    { id: "ev_impl", title: "Implementation review", excerpt: "Median implementation took 6 weeks for mid-market accounts." },
  ],
  openQuestions: [{ id: "itm_q001", text: "Which regions should the pilot cover?" }],
};

export const localStrategyBriefing = PublishedBriefingDocument.parse(localStrategyInput);
