# AUTOMATION AGENT — PHASE 5 TASK BRIEF: AI VISION INTEGRATION

> **Read these files first:**
> - `.agent/shared/global-rules.md`
> - `.agent/roles/automation-agent.md`
> - `server/src/services/automationService.js`

---

## 1. OBJECTIVE
Transform the `automationService.js` from a placeholder loop into a functional **AI Vision-Directed Browser**. You will implement the logic that allows GPT-4o/Manus to "see" the page and tell Playwright where to click.

---

## 2. ARCHITECTURE & REQUIREMENTS
- **Recursive Loop:** The `draftInvoiceOnWebsite` function must loop:
    1. Capture screenshot of current viewport.
    2. Call `aiService.visionAnalyzePage(screenshot, invoiceData)`.
    3. The AI returns a JSON: `{ "action": "click" | "type" | "wait" | "done", "selector": "...", "text": "...", "explanation": "..." }`.
    4. Execute the action via Playwright.
- **Self-Healing:** If a click fails, report it back to the AI in the next iteration so it can try a different approach (e.g., "I tried to click 'Save' but it wasn't there").
- **Dynamic Selectors:** Do NOT hardcode IDs or Classes. Rely on the AI to provide the best target (it can provide text-based selectors like `text="Submit"`).

---

## 3. STEP-BY-STEP EXECUTION
1. **Refine `automationService.js`:** Update the `while` loop to pass the current `page` and `invoiceData` to the AI service.
2. **Action Execution:** Implement a helper function `executeAiAction(page, actionObj)` that handles the `click`, `type`, and `wait` commands.
3. **Logging:** Log every AI decision to the `Invoice` document in MongoDB so the frontend can display it to the user.
4. **Termination:** Ensure the loop stops when the AI returns `action: "done"` or `maxIterations` is reached.

---

## 4. ACCEPTANCE CRITERIA
- The automation loop successfully navigates to the target URL.
- The script passes a base64 screenshot to the AI service.
- Playwright executes at least one action (e.g., a click or type) directed by the AI's response.
