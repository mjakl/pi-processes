/**
 * Routing rules for the process tool. Pi appends these to the default system
 * prompt, and the agent-guidance hook re-adds them when a custom system prompt
 * replaces that section.
 */
export function getPromptGuidelines(): string[] {
  return [
    "Use process instead of bash for long-running or blocking commands: servers, watchers, log tails, builds, test suites, and installs. If duration is uncertain, use process.",
    "Never poll with process list, process output, or process logs; follow the process tool's notification and wait guidance.",
  ];
}
