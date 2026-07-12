// Shell AST helpers. Duplicated from pi-toolchain since cross-extension imports are not allowed.

import type {
  ArrayExpr,
  Assignment,
  Command,
  FunctionDecl,
  Program,
  Redirect,
  SimpleCommand,
  Statement,
  Word,
  WordPart,
} from "@aliou/sh";

/** Resolve a shell word to the literal text available in its AST. */
export function wordToString(word: Word): string {
  return word.parts.map(partToString).join("");
}

function partToString(part: WordPart): string {
  switch (part.type) {
    case "Literal":
      return part.value;
    case "SglQuoted":
      return part.value;
    case "DblQuoted":
      return part.parts.map(partToString).join("");
    case "ParamExp":
      return part.short
        ? `$${part.param.value}`
        : `\${${part.param.value}${part.op ?? ""}${part.value ? wordToString(part.value) : ""}}`;
    case "CmdSubst":
      return "$(...)";
    case "ArithExp":
      return `$((${part.expr}))`;
    case "ProcSubst":
      return `${part.op}(...)`;
  }
}

/** Walk every SimpleCommand, including commands inside word substitutions. */
export function walkCommands(
  node: Program,
  callback: (cmd: SimpleCommand) => boolean | undefined,
): void {
  walkProgram(node, { command: callback });
}

/** Collect function declarations reached by the program's control flow. */
export function collectFunctionDeclarations(
  node: Program,
): Map<string, Statement[]> {
  const functions = new Map<string, Statement[]>();
  walkProgram(node, {
    functionDecl: (declaration) => {
      functions.set(declaration.name, declaration.body);
    },
  });
  return functions;
}

/** Return true when any executed statement is asynchronous/backgrounded. */
export function hasBackgroundStatement(node: Program): boolean {
  return walkProgram(node, {
    statement: (statement) =>
      statement.background === true ||
      statement.command.type === "CoprocClause",
  });
}

export function hasUnescapedCommandSubstitution(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const isSubstitutionStart =
      text[index] === "`" || (text[index] === "$" && text[index + 1] === "(");
    if (!isSubstitutionStart) continue;

    let precedingBackslashes = 0;
    for (
      let backslash = index - 1;
      backslash >= 0 && text[backslash] === "\\";
      backslash--
    ) {
      precedingBackslashes++;
    }
    if (precedingBackslashes % 2 === 0) return true;
  }
  return false;
}

/** Walk shell text embedded in arithmetic, parameter expansion, and heredocs. */
export function walkEmbeddedShellText(
  node: Program,
  callback: (text: string) => boolean | undefined,
): void {
  walkProgram(node, { embeddedText: callback });
}

interface WalkCallbacks {
  command?: (command: SimpleCommand) => boolean | undefined;
  statement?: (statement: Statement) => boolean | undefined;
  embeddedText?: (text: string) => boolean | undefined;
  functionDecl?: (declaration: FunctionDecl) => void;
}

function walkProgram(node: Program, callbacks: WalkCallbacks): boolean {
  return walkStatements(node.body, callbacks);
}

function walkStatement(
  statement: Statement,
  callbacks: WalkCallbacks,
): boolean {
  if (callbacks.statement?.(statement) === true) return true;
  return walkCommand(statement.command, callbacks);
}

function walkStatements(
  statements: Statement[],
  callbacks: WalkCallbacks,
): boolean {
  for (const statement of statements) {
    if (walkStatement(statement, callbacks)) return true;
  }
  return false;
}

function walkCommand(command: Command, callbacks: WalkCallbacks): boolean {
  switch (command.type) {
    case "SimpleCommand":
      return (
        callbacks.command?.(command) === true ||
        walkWords(command.words, callbacks) ||
        walkAssignments(command.assignments, callbacks) ||
        walkRedirects(command.redirects, callbacks)
      );

    case "Pipeline":
      return walkStatements(command.commands, callbacks);

    case "Logical":
      return (
        walkStatement(command.left, callbacks) ||
        walkStatement(command.right, callbacks)
      );

    case "Subshell":
    case "Block":
      return walkStatements(command.body, callbacks);

    case "IfClause": {
      const condition = getStaticCondition(command.cond);
      if (condition === true) {
        return (
          walkStatements(command.cond, callbacks) ||
          walkStatements(command.then, callbacks)
        );
      }
      if (condition === false) {
        return (
          walkStatements(command.cond, callbacks) ||
          (command.else ? walkStatements(command.else, callbacks) : false)
        );
      }
      return (
        walkStatements(command.cond, callbacks) ||
        walkStatements(command.then, callbacks) ||
        (command.else ? walkStatements(command.else, callbacks) : false)
      );
    }

    case "ForClause":
    case "SelectClause":
      return (
        walkWords(command.items, callbacks) ||
        walkStatements(command.body, callbacks)
      );

    case "WhileClause":
      return (
        walkStatements(command.cond, callbacks) ||
        walkStatements(command.body, callbacks)
      );

    case "CaseClause":
      if (walkWord(command.word, callbacks)) return true;
      for (const item of command.items) {
        if (
          walkWords(item.patterns, callbacks) ||
          walkStatements(item.body, callbacks)
        ) {
          return true;
        }
      }
      return false;

    case "FunctionDecl":
      callbacks.functionDecl?.(command);
      // Declaring a function does not execute its body.
      return false;

    case "TimeClause":
      return walkStatement(command.command, callbacks);

    case "CoprocClause":
      return walkStatement(command.body, callbacks);

    case "CStyleLoop":
      return (
        [command.init, command.cond, command.post].some(
          (expression) =>
            expression !== undefined &&
            callbacks.embeddedText?.(expression) === true,
        ) || walkStatements(command.body, callbacks)
      );

    case "TestClause":
      return walkWords(command.expr, callbacks);

    case "DeclClause":
      return (
        walkWords(command.args, callbacks) ||
        walkAssignments(command.assigns, callbacks) ||
        walkRedirects(command.redirects, callbacks)
      );

    case "LetClause":
      return (
        walkWords(command.exprs, callbacks) ||
        walkRedirects(command.redirects, callbacks)
      );

    case "ArithCmd":
      return callbacks.embeddedText?.(command.expr) === true;
  }
}

function getStaticCondition(statements: Statement[]): boolean | undefined {
  if (statements.length !== 1) return undefined;
  const statement = statements[0];
  if (statement.background || statement.command.type !== "SimpleCommand") {
    return undefined;
  }

  const command = statement.command;
  if (
    command.assignments?.length ||
    command.redirects?.length ||
    command.words?.length !== 1
  ) {
    return undefined;
  }

  const name = wordToString(command.words[0]);
  const result =
    name === "true" || name === ":"
      ? true
      : name === "false"
        ? false
        : undefined;
  return result === undefined || !statement.negated ? result : !result;
}

function walkWords(
  words: Word[] | undefined,
  callbacks: WalkCallbacks,
): boolean {
  return words?.some((word) => walkWord(word, callbacks)) ?? false;
}

function walkWord(word: Word, callbacks: WalkCallbacks): boolean {
  return word.parts.some((part) => walkWordPart(part, callbacks));
}

function walkWordPart(part: WordPart, callbacks: WalkCallbacks): boolean {
  switch (part.type) {
    case "DblQuoted":
      return part.parts.some((nested) => walkWordPart(nested, callbacks));
    case "ParamExp": {
      if (!part.value) return false;
      const text = wordToString(part.value);
      return (
        (hasUnescapedCommandSubstitution(text) &&
          callbacks.embeddedText?.(text) === true) ||
        walkWord(part.value, callbacks)
      );
    }
    case "CmdSubst":
    case "ProcSubst":
      return walkStatements(part.stmts, callbacks);
    case "ArithExp":
      return callbacks.embeddedText?.(part.expr) === true;
    case "Literal":
    case "SglQuoted":
      return false;
  }
}

function walkAssignments(
  assignments: Assignment[] | undefined,
  callbacks: WalkCallbacks,
): boolean {
  return (
    assignments?.some(
      (assignment) =>
        (assignment.value ? walkWord(assignment.value, callbacks) : false) ||
        (assignment.array
          ? walkArrayExpression(assignment.array, callbacks)
          : false),
    ) ?? false
  );
}

function walkArrayExpression(
  expression: ArrayExpr,
  callbacks: WalkCallbacks,
): boolean {
  return expression.elems.some(
    (element) =>
      (element.index ? walkWord(element.index, callbacks) : false) ||
      (element.value ? walkWord(element.value, callbacks) : false),
  );
}

function walkRedirects(
  redirects: Redirect[] | undefined,
  callbacks: WalkCallbacks,
): boolean {
  return (
    redirects?.some((redirect) => {
      if (walkWord(redirect.target, callbacks)) return true;
      if (!redirect.heredoc) return false;

      const delimiterIsQuoted =
        redirect.target.parts.some(
          (part) => part.type === "SglQuoted" || part.type === "DblQuoted",
        ) || wordToString(redirect.target).includes("\\");
      const text = wordToString(redirect.heredoc);
      return (
        (!delimiterIsQuoted &&
          hasUnescapedCommandSubstitution(text) &&
          callbacks.embeddedText?.(text) === true) ||
        walkWord(redirect.heredoc, callbacks)
      );
    }) ?? false
  );
}
