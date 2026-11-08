// ESLint's core no-restricted-syntax, which oxlint does not implement natively:
// each option names an esquery selector and the message to report where it
// matches. Oxlint's JS plugin API runs selector visitors as ESLint does, so the
// rule is the selector table itself.

import type { TSESTree } from '@typescript-eslint/utils';
import { assert } from './assert.mts';
import type { RuleModule } from './ast.mts';

interface Restriction {
  readonly selector: string;
  readonly message: string;
}

const RESTRICTIONS_MAX = 100;

export const restrictedSyntax: RuleModule<'restricted', Restriction[]> = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Syntax a part of the tree may not use, by selector.' },
    messages: { restricted: '{{message}}' },
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { selector: { type: 'string' }, message: { type: 'string' } },
        required: ['selector', 'message'],
        additionalProperties: false,
      },
    },
  },
  defaultOptions: [],
  create(context) {
    const restrictions = context.options;
    assert(restrictions.length <= RESTRICTIONS_MAX, 'restrictedSyntax: too many selectors');
    // Two restrictions can share a selector; each reports its own message.
    const bySelector = new Map<string, string[]>();
    for (const { selector, message } of restrictions) {
      const messages = bySelector.get(selector) ?? [];
      messages.push(message);
      bySelector.set(selector, messages);
    }
    assert(bySelector.size <= restrictions.length, 'restrictedSyntax: one visitor per selector');
    const visitors: Record<string, (node: TSESTree.Node) => void> = {};
    for (const [selector, messages] of bySelector) {
      visitors[selector] = (node) => {
        for (const message of messages) {
          context.report({ node, messageId: 'restricted', data: { message } });
        }
      };
    }
    return visitors;
  },
};
