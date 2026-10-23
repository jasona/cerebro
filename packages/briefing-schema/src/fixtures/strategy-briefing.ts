/**
 * Representative sample briefings (Phase 0 deliverable).
 *
 * ALL CONTENT IN THIS FILE IS FICTIONAL SAMPLE DATA. Companies, people,
 * figures, dates and evidence excerpts are invented for prototypes, seed data
 * and tests. They are not real findings and must never be presented as such.
 * Chart data is labelled illustrative in the document itself.
 *
 * Based on the reader concept (llm-docs/assets/cerebro-reader-concept.png).
 * Ids are fixed so tests, seed data and screenshots are reproducible.
 */
import { BriefingDocument, SCHEMA_VERSION } from "../document";
import type { HandoffPackageInput } from "../handoff";

const SAMPLE = "fictional sample content";

/** Company-wide strategy briefing, draft form with all evidence approved. Fictional sample data. */
export const strategyBriefing: BriefingDocument = BriefingDocument.parse({
  schemaVersion: SCHEMA_VERSION,
  title: "Our next chapter: a focused move upmarket.",
  kind: "strategy",
  position: {
    headline: "Our next chapter: a focused move upmarket.",
    summary: "Win larger customers by focusing our product, sales motion, and service model on the mid-market.",
  },
  context: {
    stakes:
      "Our strongest retention and expansion come from customers with 100–1,000 employees, yet our roadmap and sales capacity are spread evenly across every segment. Each quarter we defer a choice, we fund growth where returns are weakest.",
    background:
      "Over the past year, larger customers have asked for administration, security review and onboarding support that our small-business motion was not designed to provide.",
  },
  request: {
    type: "decision",
    statement: "Approve a 90-day mid-market pilot.",
    detail: "A focused team. A defined investment. Clear stop-or-scale criteria.",
    dueDate: "2026-11",
  },
  sections: [
    {
      id: "sec_recommendation",
      title: "The recommendation",
      blocks: [
        {
          id: "blk_rec_decision",
          type: "decision",
          statement: "Approve a 90-day mid-market pilot.",
          options: [
            {
              id: "itm_opt_enterprise",
              label: "Move into enterprise now",
              description: "Build a full enterprise motion this year.",
            },
            {
              id: "itm_opt_pilot",
              label: "Run a 90-day mid-market pilot",
              description: "A dedicated pod tests the mid-market motion against stop-or-scale criteria.",
              chosen: true,
            },
            {
              id: "itm_opt_stay",
              label: "Stay the course",
              description: "Keep serving every segment with the current motion.",
            },
          ],
          rationale: "Mid-market combines stronger expansion with a shorter path to value. The pilot tests that advantage before we commit to a larger enterprise motion.",
          evidenceRefs: [{ evidenceId: "ev_cohort_q3", note: "Retention advantage by segment" }],
        },
        {
          id: "blk_rec_narrative",
          type: "narrative",
          role: "general",
          text: "We will form one cross-functional pod (product, sales and customer success) to serve mid-market accounts for 90 days. At day 90 we decide to scale, adjust or stop, using criteria agreed before the pilot starts.",
        },
      ],
    },
    {
      id: "sec_why_now",
      title: "Why now",
      blocks: [
        {
          id: "blk_why_retention",
          type: "narrative",
          role: "context",
          text: "Our strongest retention and expansion come from customers with 100–1,000 employees.",
          evidenceRefs: [{ evidenceId: "ev_cohort_q3" }],
        },
        {
          id: "blk_why_nrr_chart",
          type: "chart",
          title: "Net revenue retention by segment",
          kind: "bar",
          unit: "%",
          series: [
            {
              label: "Net revenue retention",
              points: [
                { x: "Small business", y: 96 },
                { x: "Mid-market", y: 124 },
                { x: "Enterprise", y: 112 },
              ],
            },
          ],
          altText:
            "Bar chart of net revenue retention by segment (illustrative): small business 96%, mid-market 124%, enterprise 112%.",
          caption: "Illustrative cohort data · Q3 2026 (fictional sample data)",
          evidenceRefs: [{ evidenceId: "ev_cohort_q3" }],
        },
      ],
    },
    {
      id: "sec_evidence",
      title: "The evidence",
      blocks: [
        {
          id: "blk_ev_nrr_metric",
          type: "metric",
          label: "Mid-market net revenue retention",
          value: 124,
          unit: "%",
          asOf: "2026-09",
          comparison: { label: "Enterprise", value: 112 },
          context: "Trailing four quarters, illustrative cohort data.",
          evidenceRefs: [{ evidenceId: "ev_cohort_q3" }],
        },
        {
          id: "blk_ev_time_to_value",
          type: "key_finding",
          statement: "Mid-market accounts reach first value in roughly a third of the time enterprise accounts take.",
          detail: "Lower implementation complexity means the pilot can show results inside 90 days.",
          evidenceRefs: [{ evidenceId: "ev_implementation_review" }],
        },
        {
          id: "blk_ev_sales_cycle",
          type: "key_finding",
          statement: "Mid-market deals close faster and need fewer custom security reviews.",
          evidenceRefs: [{ evidenceId: "ev_pipeline_review" }],
        },
      ],
    },
    {
      id: "sec_tradeoffs",
      title: "Tradeoffs",
      blocks: [
        {
          id: "blk_tradeoff_options",
          type: "comparison",
          title: "What we are choosing — and what we are deferring",
          columns: ["What it means", "Investment", "Main risk"],
          rows: [
            {
              label: "Enterprise now",
              cells: ["New sales team, security programme and services arm", "High", "Long cycles before any signal"],
            },
            {
              label: "Mid-market pilot",
              cells: ["One dedicated pod for 90 days", "Bounded", "Pilot too small to be conclusive"],
            },
            {
              label: "Stay the course",
              cells: ["No change to plan", "None", "Growth stays concentrated where retention is weakest"],
            },
          ],
        },
        {
          id: "blk_tradeoff_defer",
          type: "risk",
          kind: "tradeoff",
          statement: "Two small-business roadmap items move out by one quarter to staff the pod.",
        },
        {
          id: "blk_risk_capacity",
          type: "risk",
          kind: "risk",
          statement: "Onboarding demand from mid-market accounts exceeds the pod's support capacity.",
          likelihood: "medium",
          impact: "high",
          mitigation: "Cap pilot intake and review support load every two weeks.",
          evidenceRefs: [{ evidenceId: "ev_support_capacity" }],
        },
        {
          id: "blk_assumption_pricing",
          type: "risk",
          kind: "assumption",
          statement: "Current pricing tiers are acceptable to mid-market buyers without a new plan.",
        },
        {
          id: "blk_uncertainty_signal",
          type: "risk",
          kind: "uncertainty",
          statement: "Whether 90 days is long enough to observe expansion behaviour, not just new bookings.",
        },
      ],
    },
    {
      id: "sec_next_steps",
      title: "Next steps",
      blocks: [
        {
          id: "blk_next_timeline",
          type: "timeline",
          title: "Pilot plan",
          items: [
            { id: "itm_tl_form", label: "Form the pod and agree stop-or-scale criteria", date: "2026-11" },
            { id: "itm_tl_run", label: "Run the pilot with the first cohort of accounts", date: "2026-12" },
            { id: "itm_tl_decide", label: "Day-90 review: scale, adjust or stop", date: "2027-02" },
          ],
        },
        {
          id: "blk_action_criteria",
          type: "action",
          statement: "Draft stop-or-scale criteria for leadership review.",
          owner: "Maya Chen",
          dueDate: "2026-11-13",
        },
        {
          id: "blk_action_pod",
          type: "action",
          statement: "Nominate pod members from product, sales and customer success.",
          owner: "Alex Rivera",
          dueDate: "2026-11-20",
        },
        {
          id: "blk_action_budget",
          type: "action",
          statement: "Confirm the pilot budget envelope.",
          owner: "Priya Shah",
        },
      ],
    },
  ],
  perspectives: [
    {
      id: "psp_finance",
      label: "Finance",
      audience: "Finance leadership",
      summary: "The pilot caps spend at one pod for one quarter and produces the retention evidence needed before a larger investment case.",
      emphasis: ["sec_tradeoffs", "sec_evidence"],
      implications: [
        {
          id: "itm_fin_budget",
          text: "Budget exposure is bounded to the pod's cost for 90 days; no new headcount is committed beyond it.",
          blockIds: ["blk_tradeoff_options", "blk_action_budget"],
        },
        {
          id: "itm_fin_signal",
          text: "Scale decisions should rest on retention and expansion, not bookings alone.",
          blockIds: ["blk_ev_nrr_metric", "blk_uncertainty_signal"],
        },
      ],
    },
    {
      id: "psp_operations",
      label: "Operations",
      audience: "Customer success and support leads",
      summary: "The main operational load is onboarding; intake caps and a fortnightly review keep support capacity safe.",
      emphasis: ["sec_next_steps", "sec_tradeoffs"],
      implications: [
        {
          id: "itm_ops_capacity",
          text: "Support needs a named pod contact and an intake cap before the first cohort starts.",
          blockIds: ["blk_risk_capacity"],
        },
        {
          id: "itm_ops_staffing",
          text: "Two customer success staff move to the pod for the pilot's duration.",
          blockIds: ["blk_action_pod"],
        },
      ],
    },
  ],
  evidence: [
    {
      id: "ev_cohort_q3",
      title: "Customer cohort analysis",
      excerpt:
        "Accounts with 100–1,000 employees recorded 124% net revenue retention over the trailing four quarters, compared with 112% for enterprise and 96% for small business.",
      attribution: `Customer cohort analysis, Q3 2026 (${SAMPLE})`,
      locator: "p. 8",
      origin: "upload",
      status: "approved",
    },
    {
      id: "ev_implementation_review",
      title: "Implementation review",
      excerpt: "Median time to first value was 41 days for mid-market accounts and 118 days for enterprise accounts.",
      attribution: `Implementation review, Q3 2026 (${SAMPLE})`,
      locator: "Section 2",
      origin: "upload",
      status: "approved",
    },
    {
      id: "ev_pipeline_review",
      title: "Sales pipeline review",
      excerpt: "Mid-market opportunities closed in a median 54 days; fewer than one in five required a custom security review.",
      attribution: `Sales pipeline review, September 2026 (${SAMPLE})`,
      locator: "slide 6",
      origin: "manual",
      status: "approved",
    },
    {
      id: "ev_support_capacity",
      title: "Support capacity model",
      excerpt: "At current staffing, the support team can absorb onboarding for roughly 25 additional mid-market accounts per quarter.",
      attribution: `Support capacity model, Q3 2026 (${SAMPLE})`,
      locator: "tab \"Capacity\"",
      origin: "manual",
      status: "approved",
    },
  ],
  openQuestions: [
    { id: "itm_q_criteria", text: "Which retention threshold should trigger a scale decision at day 90?" },
    { id: "itm_q_pricing", text: "Do we need a mid-market plan, or are current tiers enough for the pilot?" },
  ],
});

/** Smaller team-restricted plan for the Platform team. One approved and one candidate excerpt. Fictional sample data. */
export const teamPlanBriefing: BriefingDocument = BriefingDocument.parse({
  schemaVersion: SCHEMA_VERSION,
  title: "Platform readiness for the mid-market pilot",
  kind: "plan",
  position: {
    headline: "Platform can support the pilot if we ship SSO and audit logs first.",
    summary: "We will prioritise single sign-on and audit logging this quarter so pilot accounts can pass security review without custom work.",
  },
  context: {
    stakes: "Pilot accounts start onboarding next month; without SSO, each security review becomes a custom engagement.",
  },
  request: {
    type: "input",
    statement: "Flag any dependency that would delay SSO or audit logs.",
  },
  sections: [
    {
      id: "sec_tp_plan",
      title: "The plan",
      blocks: [
        {
          id: "blk_tp_plan",
          type: "narrative",
          role: "general",
          text: "SSO ships first, then audit logs. Other roadmap items keep their current order behind these two.",
          evidenceRefs: [{ evidenceId: "ev_tp_security_reviews" }],
        },
      ],
    },
    {
      id: "sec_tp_risks",
      title: "Risks",
      blocks: [
        {
          id: "blk_tp_risk_idp",
          type: "risk",
          kind: "risk",
          statement: "Identity-provider integration testing takes longer than planned.",
          likelihood: "medium",
          impact: "medium",
        },
      ],
    },
    {
      id: "sec_tp_next",
      title: "Next steps",
      blocks: [
        {
          id: "blk_tp_action_sso",
          type: "action",
          statement: "Publish the SSO design for review.",
          owner: "Jordan Ellis",
          dueDate: "2026-11-06",
        },
      ],
    },
  ],
  perspectives: [],
  evidence: [
    {
      id: "ev_tp_security_reviews",
      title: "Security review log",
      excerpt: "Seven of the last ten mid-market security questionnaires asked for SSO before contract signature.",
      attribution: `Security review log, Q3 2026 (${SAMPLE})`,
      origin: "manual",
      status: "approved",
    },
    {
      id: "ev_tp_draft_estimate",
      title: "Engineering estimate (draft)",
      excerpt: "Initial estimate: audit logging needs two sprints after SSO lands.",
      attribution: `Platform planning notes (${SAMPLE})`,
      origin: "llm_handoff",
      status: "candidate",
    },
  ],
  openQuestions: [{ id: "itm_tp_q_scim", text: "Is SCIM provisioning needed for the pilot, or can it wait?" }],
});

/**
 * What a connected ChatGPT conversation might send for: "Turn this into a
 * Cerebro brief for the Platform team. Make it visible to the company."
 * Evidence arrives as candidates; destination/audience are proposals the
 * domain layer resolves. Fictional sample data.
 */
export const sampleHandoff: HandoffPackageInput = {
  handoffVersion: 1,
  title: "Platform priorities for the mid-market pilot",
  kind: "plan",
  selectedContent:
    "We agreed SSO is the blocker for mid-market security reviews. Audit logs come next. SCIM can probably wait until after the pilot, but we should confirm with sales.",
  position: {
    headline: "Ship SSO, then audit logs, before pilot onboarding starts.",
    summary: "Platform will prioritise single sign-on and audit logging so pilot accounts can pass security review without custom work.",
  },
  context: {
    stakes: "Pilot onboarding starts next month. Without SSO, every security review becomes a custom engagement for the pod.",
  },
  request: {
    type: "approval",
    statement: "Approve moving SSO and audit logs ahead of the current Platform roadmap.",
  },
  rationale: "Security review is the most common blocker in mid-market deals, and SSO resolves most of those questions.",
  alternatives: [
    { label: "SSO and audit logs first", pros: "Unblocks security reviews", cons: "Delays two roadmap items", chosen: true },
    { label: "Keep the current roadmap", pros: "No re-planning", cons: "Pilot accounts need custom security work" },
  ],
  assumptions: ["Pilot accounts use a standard SAML or OIDC identity provider."],
  risks: [{ statement: "Identity-provider testing takes longer than planned.", likelihood: "medium", impact: "medium" }],
  openQuestions: ["Is SCIM provisioning needed for the pilot, or can it wait?"],
  actions: [
    { statement: "Publish the SSO design for review.", owner: "Jordan Ellis" },
    { statement: "Confirm SCIM requirements with sales." },
  ],
  perspectives: [
    {
      label: "Sales",
      audience: "Mid-market account executives",
      summary: "SSO removes the most common security-review blocker for pilot deals.",
      emphasis: ["recommendation", "risks"],
      implications: ["Account executives can commit to SSO availability for pilot accounts."],
    },
  ],
  evidence: [
    {
      title: "Security review log",
      excerpt: "Seven of the last ten mid-market security questionnaires asked for SSO before contract signature.",
      attribution: "Security review log, Q3 2026 (fictional sample content)",
      supports: ["why_now"],
    },
    {
      title: "Planning conversation notes",
      excerpt: "Audit logging needs about two sprints after SSO lands.",
      attribution: "ChatGPT conversation, selected by the author (fictional sample content)",
      sourceUrl: "https://chatgpt.com/c/example-conversation",
      supports: ["rationale"],
    },
  ],
  destination: { label: "Platform team" },
  audience: { visibility: "company" },
  origin: { host: "ChatGPT", conversationLabel: "Platform priorities for the pilot" },
};
