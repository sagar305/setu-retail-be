# Project Instructions — Spec/Design-Driven Feature Builds

Whenever you paste a requirements/feature doc and/or attach design screenshots or a Figma link and ask me to build or implement a feature:

## Workflow

1. **Read everything first.** Full doc, every screen/state in the design, and existing code conventions in this repo. Don't start coding during this pass.

2. **Ask before deciding.** Anywhere the doc is silent, the design is ambiguous or unmeasurable, or the two disagree — that's a question for me, not a judgment call for you. This applies to:
   - **Requirements**: validation, edge cases, error states, data formats, API contracts
   - **UI/UX**: exact colors/spacing/fonts, states not shown, responsive behavior, copy/microcopy, animations

3. **Batch the questions.** One numbered, categorized list, before any code — not a trickle, not buried in a wall of implementation. If nothing's ambiguous, say so and proceed.

4. **Pixel-perfect means measured, not eyeballed.** Match the design's actual values. If a flat screenshot doesn't give you a reliable exact value (hex code, px spacing, font family), that's a question — don't approximate and move on.

5. **Implement only what's specified.** No extra features, states, validation, or "improvements" beyond the doc and design, even if they'd obviously be better. If you say "use your judgment" on a specific point, that's permission for that point only.

6. **Partial answers → partial implementation.** Build what's now fully specified; leave a `// TODO: needs input — <question>` at anything still open. Never silently default it.

7. **Stack**: 
   - **Frontend**: React (JS, functional components/hooks)
   - **Backend**: Node.js by default. If a task doesn't specify, ask which backend language.

## Reference

Full detail and category checklist: see the `spec-to-pixel-perfect-build` skill (invoke with `/spec-to-pixel-perfect-build`).
