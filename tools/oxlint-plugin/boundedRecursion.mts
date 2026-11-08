// AGENTS.md §10: recursion needs a stated, checked depth bound — an unbounded
// stack is an unbounded loop by another name. A function that calls itself by
// name must compare a depth (an identifier or property named `…depth…`)
// against a `LIMITS` bound somewhere in its body: `assert(depth <=
// LIMITS.treeDepthMax, …)` for an invariant, or `if (depth > LIMITS.…)` that
// returns a failure for untrusted input. Mutual recursion is not detected;
// review catches it.

import type { TSESTree } from '@typescript-eslint/utils';
import { assert } from './assert.mts';
import { functionName, type FunctionNode, type RuleModule } from './ast.mts';

const COMPARISONS = new Set(['<', '<=', '>', '>=']);
const DEPTH_NAME = /depth/i;

export const boundedRecursion: RuleModule<'unbounded'> = {
  meta: {
    type: 'problem',
    docs: { description: 'Recursive functions check a depth against LIMITS (AGENTS.md §10).' },
    messages: {
      unbounded:
        "'{{name}}' calls itself without comparing a depth to a LIMITS bound: assert " +
        '`depth <= LIMITS.…` (or fail when it is exceeded), or iterate (AGENTS.md §10).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    // Each function being visited, innermost last, with what its body showed.
    interface Frame {
      readonly node: FunctionNode;
      readonly name: string | undefined;
      readonly callee: Callee | undefined;
      recursive: boolean;
      bounded: boolean;
    }
    const frames: Frame[] = [];

    function enter(node: FunctionNode): void {
      const frame = { node, name: functionName(node), callee: selfCallee(node) };
      frames.push({ ...frame, recursive: false, bounded: false });
    }

    function exit(node: FunctionNode): void {
      const frame = frames.pop();
      assert(frame !== undefined, 'bounded-recursion: exit without enter');
      assert(frame.node === node, 'bounded-recursion: frames out of order');
      if (frame.recursive) {
        if (frame.bounded) {
          return;
        }
        const name = frame.name ?? 'function';
        context.report({ node, messageId: 'unbounded', data: { name } });
      }
    }

    return {
      FunctionDeclaration: enter,
      FunctionExpression: enter,
      ArrowFunctionExpression: enter,
      'FunctionDeclaration:exit': exit,
      'FunctionExpression:exit': exit,
      'ArrowFunctionExpression:exit': exit,
      CallExpression(node) {
        const callee = calleeOf(node);
        if (callee === undefined) {
          return;
        }
        // A nested closure that calls an outer function by name recurses
        // through it, so every enclosing frame of that name is marked.
        for (const frame of frames) {
          if (frame.callee === undefined) {
            continue;
          }
          if (frame.callee.kind === callee.kind && frame.callee.name === callee.name) {
            frame.recursive = true;
          }
        }
      },
      BinaryExpression(node) {
        if (!COMPARISONS.has(node.operator)) {
          return;
        }
        if (isDepthBound(node.left, node.right) || isDepthBound(node.right, node.left)) {
          const frame = frames.at(-1);
          if (frame !== undefined) {
            frame.bounded = true;
          }
        }
      },
    };
  },
};

// How a function can call itself. A declared or variable-bound function calls
// itself by its bare name; a method or an object property only through
// `this.name()` — a property's key is not in scope, so `{ setTimeout: (…) =>
// setTimeout(…) }` calls the global, not itself.
type Callee = { readonly kind: 'binding' | 'member'; readonly name: string };

function selfCallee(node: FunctionNode): Callee | undefined {
  if (node.id) {
    return { kind: 'binding', name: node.id.name };
  }
  const parent = node.parent;
  if (parent.type === 'VariableDeclarator') {
    return parent.id.type === 'Identifier' ? { kind: 'binding', name: parent.id.name } : undefined;
  }
  if (parent.type === 'MethodDefinition' || parent.type === 'Property') {
    return parent.key.type === 'Identifier' ? { kind: 'member', name: parent.key.name } : undefined;
  }
  return undefined;
}

function calleeOf(node: TSESTree.CallExpression): Callee | undefined {
  if (node.callee.type === 'Identifier') {
    return { kind: 'binding', name: node.callee.name };
  }
  // `this.walk(child)` inside a method named walk.
  if (node.callee.type === 'MemberExpression') {
    if (node.callee.object.type === 'ThisExpression') {
      if (node.callee.property.type === 'Identifier') {
        return { kind: 'member', name: node.callee.property.name };
      }
    }
  }
  return undefined;
}

function isDepthBound(depth: TSESTree.Node, bound: TSESTree.Node): boolean {
  return mentionsDepth(depth) && rootsAtLimits(bound);
}

function mentionsDepth(node: TSESTree.Node): boolean {
  // `depth + 1 <= LIMITS.…` checks the depth about to be entered: look one
  // level into the arithmetic, no further.
  let target: TSESTree.Node = node;
  if (node.type === 'BinaryExpression') {
    if (node.left.type !== 'PrivateIdentifier') {
      target = node.left;
    }
  }
  if (target.type === 'Identifier') {
    return DEPTH_NAME.test(target.name);
  }
  if (target.type === 'MemberExpression') {
    if (target.property.type === 'Identifier') {
      return DEPTH_NAME.test(target.property.name);
    }
  }
  return false;
}

// `LIMITS.treeDepthMax`, or a module's own bounds object named the same way
// (`POLICY_LIMITS.…`): AGENTS.md §5 keeps a bound in LIMITS or next to the
// code that enforces it.
function rootsAtLimits(node: TSESTree.Node): boolean {
  if (node.type !== 'MemberExpression') {
    return false;
  }
  return node.object.type === 'Identifier' && /(?:^|_)LIMITS$/.test(node.object.name);
}
