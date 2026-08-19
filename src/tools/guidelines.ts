/**
 * Routing rules for the process tool. Pi appends these to the default system
 * prompt, and the agent-guidance hook re-adds them when a custom system prompt
 * replaces that section.
 */
const BASE_GUIDELINES = [
  "Run anything long-running or blocking through the process tool instead of bash: servers, watchers and log tails, and slow work such as builds, test suites and installs. If you are unsure how long a command takes, start it as a process.",
  "Never poll processes managed by the process tool with process list or process output.",
];

export function getPromptGuidelines(exposeWait: boolean): string[] {
  return exposeWait
    ? [
        ...BASE_GUIDELINES,
        "In print and JSON modes, process wait is the reliable source of completion and readiness results; use it once when the run depends on a managed process finishing or printing a specific output marker.",
      ]
    : [
        ...BASE_GUIDELINES,
        "In TUI and RPC modes, processes managed by the process tool notify you automatically when they end. Use readyPattern on process start when an immediate next step depends on a specific output marker. If no independent work remains after start, give a short status update and end your turn; the automatic notification will resume you.",
      ];
}
