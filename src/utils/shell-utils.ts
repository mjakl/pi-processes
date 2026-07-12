import {
  type ArithmeticExpression,
  type Command,
  type Node,
  parse,
  type Redirect,
  type Script,
  type Function as ShellFunction,
  type Statement,
  type TestExpression,
  type Word,
  type WordPart,
} from "unbash";

export interface ShellProgram {
  script: Script;
  source: string;
}

export type SimpleCommand = Command;

export function parseShell(source: string): ShellProgram {
  const script = parse(source);
  if (script.errors?.length) {
    throw new Error(script.errors[0].message);
  }
  return { script, source };
}

/** Resolve a shell word to its semantic literal value. */
export function wordToString(word: Word): string {
  return word.value;
}

export function commandToWords(command: Command): string[] {
  return command.name
    ? [wordToString(command.name), ...command.suffix.map(wordToString)]
    : [];
}

/** Walk every executed simple command, including substitutions. */
export function walkCommands(
  program: ShellProgram,
  callback: (command: Command) => boolean | undefined,
): void {
  walkProgram(program, { command: callback });
}

/** Collect function declarations reached by the program's control flow. */
export function collectFunctionDeclarations(
  program: ShellProgram,
): Map<string, ShellProgram> {
  const functions = new Map<string, ShellProgram>();
  walkProgram(program, {
    functionDecl: (declaration) => {
      functions.set(
        wordToString(declaration.name),
        nodeToProgram(declaration.body, program.source),
      );
    },
  });
  return functions;
}

/** Return true when any executed statement is asynchronous/backgrounded. */
export function hasBackgroundStatement(program: ShellProgram): boolean {
  return walkProgram(program, {
    statement: (statement) => statement.background === true,
    coproc: () => true,
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

/** Walk raw shell text in parser-limited arithmetic/expansion fields. */
export function walkEmbeddedShellText(
  program: ShellProgram,
  callback: (text: string) => boolean | undefined,
): void {
  walkProgram(program, { embeddedText: callback });
}

interface WalkCallbacks {
  command?: (command: Command) => boolean | undefined;
  statement?: (statement: Statement) => boolean | undefined;
  embeddedText?: (text: string) => boolean | undefined;
  functionDecl?: (declaration: ShellFunction) => void;
  coproc?: () => boolean | undefined;
}

function walkProgram(program: ShellProgram, callbacks: WalkCallbacks): boolean {
  return walkStatements(program.script.commands, callbacks, program.source);
}

function walkStatements(
  statements: Statement[],
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  for (const statement of statements) {
    if (walkStatement(statement, callbacks, source)) return true;
  }
  return false;
}

function walkStatement(
  statement: Statement,
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  return (
    callbacks.statement?.(statement) === true ||
    walkRedirects(statement.redirects, callbacks, source) ||
    walkNode(statement.command, callbacks, source)
  );
}

function walkNode(
  node: Node,
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  switch (node.type) {
    case "Statement":
      return walkStatement(node, callbacks, source);

    case "Command":
      return (
        callbacks.command?.(node) === true ||
        walkWord(node.name, callbacks, source) ||
        walkWords(node.suffix, callbacks, source) ||
        node.prefix.some(
          (assignment) =>
            Boolean(
              assignment.index &&
                hasUnescapedCommandSubstitution(assignment.index) &&
                callbacks.embeddedText?.(assignment.index) === true,
            ) ||
            walkWord(assignment.value, callbacks, source) ||
            walkWords(assignment.array, callbacks, source),
        ) ||
        walkRedirects(node.redirects, callbacks, source)
      );

    case "Pipeline":
    case "AndOr":
      return node.commands.some((command) =>
        walkNode(command, callbacks, source),
      );

    case "If": {
      const condition = getStaticCondition(node.clause.commands);
      if (walkStatements(node.clause.commands, callbacks, source)) return true;
      if (condition !== false && walkNode(node.then, callbacks, source)) {
        return true;
      }
      return (
        condition !== true &&
        node.else !== undefined &&
        walkNode(node.else, callbacks, source)
      );
    }

    case "For":
    case "Select":
      return (
        walkWords(node.wordlist, callbacks, source) ||
        walkNode(node.body, callbacks, source)
      );

    case "ArithmeticFor": {
      const header = source.slice(node.pos, node.body.pos);
      return (
        (hasUnescapedCommandSubstitution(header) &&
          callbacks.embeddedText?.(header) === true) ||
        walkArithmetic(node.initialize, callbacks, source) ||
        walkArithmetic(node.test, callbacks, source) ||
        walkArithmetic(node.update, callbacks, source) ||
        walkNode(node.body, callbacks, source)
      );
    }

    case "While":
      return (
        walkNode(node.clause, callbacks, source) ||
        walkNode(node.body, callbacks, source)
      );

    case "Function":
      callbacks.functionDecl?.(node);
      // A declaration does not execute its body until invoked.
      return walkRedirects(node.redirects, callbacks, source);

    case "Subshell":
    case "BraceGroup":
      return walkNode(node.body, callbacks, source);

    case "CompoundList":
      return walkStatements(node.commands, callbacks, source);

    case "Case":
      if (walkWord(node.word, callbacks, source)) return true;
      return node.items.some(
        (item) =>
          walkWords(item.pattern, callbacks, source) ||
          walkNode(item.body, callbacks, source),
      );

    case "Coproc":
      return (
        callbacks.coproc?.() === true ||
        walkNode(node.body, callbacks, source) ||
        walkRedirects(node.redirects, callbacks, source)
      );

    case "TestCommand":
      return walkTestExpression(node.expression, callbacks, source);

    case "ArithmeticCommand":
      return (
        (hasUnescapedCommandSubstitution(node.body) &&
          callbacks.embeddedText?.(node.body) === true) ||
        walkArithmetic(node.expression, callbacks, source)
      );
  }
}

function getStaticCondition(statements: Statement[]): boolean | undefined {
  if (statements.length !== 1) return undefined;
  const statement = statements[0];
  if (statement.background || statement.redirects.length > 0) return undefined;

  let commandNode: Node = statement.command;
  let negated = false;
  if (
    commandNode.type === "Pipeline" &&
    commandNode.commands.length === 1 &&
    commandNode.operators.length === 0
  ) {
    negated = commandNode.negated === true;
    commandNode = commandNode.commands[0];
  }
  if (commandNode.type !== "Command") return undefined;

  const command = commandNode;
  if (
    command.prefix.length > 0 ||
    command.redirects.length > 0 ||
    command.suffix.length > 0 ||
    !command.name
  ) {
    return undefined;
  }

  const name = wordToString(command.name);
  const result =
    name === "true" || name === ":"
      ? true
      : name === "false"
        ? false
        : undefined;
  return result === undefined || !negated ? result : !result;
}

function walkWords(
  words: Word[] | undefined,
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  return words?.some((word) => walkWord(word, callbacks, source)) ?? false;
}

function walkWord(
  word: Word | undefined,
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  if (!word) return false;
  if (word.parts) {
    return word.parts.some((part) => walkWordPart(part, callbacks, source));
  }
  return (
    hasUnescapedCommandSubstitution(word.text) &&
    callbacks.embeddedText?.(word.text) === true
  );
}

function walkWordPart(
  part: WordPart,
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  switch (part.type) {
    case "DoubleQuoted":
    case "LocaleString":
      return part.parts.some((nested) =>
        walkWordPart(nested, callbacks, source),
      );

    case "ParameterExpansion": {
      const operandText = part.operand?.text ?? "";
      return (
        (hasUnescapedCommandSubstitution(operandText) &&
          callbacks.embeddedText?.(operandText) === true) ||
        walkWord(part.operand, callbacks, source) ||
        walkWord(part.slice?.offset, callbacks, source) ||
        walkWord(part.slice?.length, callbacks, source) ||
        walkWord(part.replace?.pattern, callbacks, source) ||
        walkWord(part.replace?.replacement, callbacks, source)
      );
    }

    case "CommandExpansion":
    case "ProcessSubstitution":
      return part.script
        ? walkStatements(part.script.commands, callbacks, source)
        : Boolean(
            part.inner &&
              hasUnescapedCommandSubstitution(part.text) &&
              callbacks.embeddedText?.(part.inner) === true,
          );

    case "ArithmeticExpansion":
      return (
        walkArithmetic(part.expression, callbacks, source) ||
        (part.expression === undefined &&
          hasUnescapedCommandSubstitution(part.text) &&
          callbacks.embeddedText?.(part.text) === true)
      );

    case "ExtendedGlob":
      return (
        hasUnescapedCommandSubstitution(part.pattern) &&
        callbacks.embeddedText?.(part.pattern) === true
      );

    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
    case "SimpleExpansion":
    case "BraceExpansion":
      return false;
  }
}

function walkArithmetic(
  expression: ArithmeticExpression | undefined,
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  if (!expression) return false;
  switch (expression.type) {
    case "ArithmeticBinary":
      return (
        walkArithmetic(expression.left, callbacks, source) ||
        walkArithmetic(expression.right, callbacks, source)
      );
    case "ArithmeticUnary":
      return walkArithmetic(expression.operand, callbacks, source);
    case "ArithmeticTernary":
      return (
        walkArithmetic(expression.test, callbacks, source) ||
        walkArithmetic(expression.consequent, callbacks, source) ||
        walkArithmetic(expression.alternate, callbacks, source)
      );
    case "ArithmeticGroup":
      return walkArithmetic(expression.expression, callbacks, source);
    case "ArithmeticCommandExpansion":
      return expression.script
        ? walkStatements(expression.script.commands, callbacks, source)
        : Boolean(
            expression.inner &&
              callbacks.embeddedText?.(expression.inner) === true,
          );
    case "ArithmeticWord":
      return (
        hasUnescapedCommandSubstitution(expression.value) &&
        callbacks.embeddedText?.(expression.value) === true
      );
  }
}

function walkTestExpression(
  expression: TestExpression,
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  switch (expression.type) {
    case "TestUnary":
      return walkWord(expression.operand, callbacks, source);
    case "TestBinary":
      return (
        walkWord(expression.left, callbacks, source) ||
        walkWord(expression.right, callbacks, source)
      );
    case "TestLogical":
      return (
        walkTestExpression(expression.left, callbacks, source) ||
        walkTestExpression(expression.right, callbacks, source)
      );
    case "TestNot":
      return walkTestExpression(expression.operand, callbacks, source);
    case "TestGroup":
      return walkTestExpression(expression.expression, callbacks, source);
  }
}

function walkRedirects(
  redirects: Redirect[] | undefined,
  callbacks: WalkCallbacks,
  source: string,
): boolean {
  return (
    redirects?.some((redirect) => {
      if (walkWord(redirect.target, callbacks, source)) return true;
      if (walkWord(redirect.body, callbacks, source)) return true;
      return Boolean(
        !redirect.heredocQuoted &&
          redirect.content &&
          hasUnescapedCommandSubstitution(redirect.content) &&
          callbacks.embeddedText?.(redirect.content) === true,
      );
    }) ?? false
  );
}

function nodeToProgram(node: Node, source: string): ShellProgram {
  const commands =
    node.type === "CompoundList"
      ? node.commands
      : node.type === "BraceGroup" || node.type === "Subshell"
        ? node.body.commands
        : node.type === "Statement"
          ? [node]
          : [
              {
                type: "Statement" as const,
                pos: node.pos,
                end: node.end,
                command: node,
                background: undefined,
                redirects: [],
              },
            ];
  return {
    source,
    script: {
      type: "Script",
      pos: node.pos,
      end: node.end,
      shebang: undefined,
      commands,
    },
  };
}
