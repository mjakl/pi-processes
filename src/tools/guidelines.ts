/**
 * Routing rules for the process tool. Pi appends these to the default system
 * prompt, and the agent-guidance hook re-adds them when a custom system prompt
 * replaces that section.
 */
const BASE_GUIDELINES = [
  "Run anything long-running or blocking through the process tool instead of bash: servers, watchers and log tails, and slow work such as builds, test suites and installs. If you are unsure how long a command takes, start it as a process.",
  "Never poll processes managed by the process tool with process list or process output.",
];

export function getPromptGuidelines(defaultWait: boolean): string[] {
  return defaultWait
    ? [
        ...BASE_GUIDELINES,
        "Use process wait for required completion or readiness results before ending a print or JSON run. Wait is available in every mode. A wait timeout leaves the process running; wait again if the result is still required. Keep individual waits within your available execution time, including any caller inactivity limit.",
      ]
    : [
        ...BASE_GUIDELINES,
        "In long-lived TUI and RPC sessions, processes managed by the process tool notify you automatically when they end. Use readyPattern on process start for asynchronous readiness. Normally, if no independent work remains after start, give a short status update and end your turn; the automatic notification will resume you. For explicit run-to-completion work or when required results must be obtained before this run ends, use process wait instead. A wait timeout leaves the process running; wait again if the result is still required. Keep individual waits within your available execution time, including any caller inactivity limit.",
      ];
}
