/**
 * Routing rules for the process tool. Pi appends these to the default system
 * prompt, and the agent-guidance hook re-adds them when a custom system prompt
 * replaces that section.
 */
export const PROMPT_GUIDELINES = [
  "Run anything long-running or blocking through the process tool instead of bash: servers, watchers and log tails, and slow work such as builds, test suites and installs. If you are unsure how long a command takes, start it as a process.",
  "To wait for a process, call process wait (until exit, until its output matches a pattern, or until a timeout). Never re-run process list or process output in a loop to check whether something finished or became ready.",
];
