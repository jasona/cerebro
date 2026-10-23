"use client";

/** Last-resort boundary when the root layout itself fails. Inline styles only. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f7f4ee", color: "#2a2930", margin: 0 }}>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "80px 16px" }}>
          <h1 style={{ fontFamily: "Georgia, serif", color: "#17161c" }}>Cerebro is temporarily unavailable</h1>
          <p>Try again in a moment.</p>
          {error.digest ? <p style={{ fontFamily: "monospace", fontSize: 12 }}>Reference: {error.digest}</p> : null}
          <button type="button" onClick={reset} style={{ marginTop: 16, padding: "8px 16px" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
