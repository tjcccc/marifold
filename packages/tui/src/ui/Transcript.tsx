import React from 'react';
import { Box, Text } from 'ink';
import type { NoticeTone, TranscriptItem } from '../core/appState.js';
import { Markdown } from './Markdown.js';
import { ACCENT, COMMAND, DIM, SKILL } from './theme.js';

const NOTICE_COLOR: Record<NoticeTone, string> = {
  info: 'gray',
  warn: 'yellow',
  error: 'red',
};

export function TranscriptRow({ item }: { item: TranscriptItem }): React.ReactElement | null {
  switch (item.kind) {
    case 'user': {
      // The submitted input is the divider between turns: framed with top and
      // bottom accent rules. A `/command` and a `$skill` echo in their own
      // colors; a plain message keeps the `>` prompt.
      const command = item.text.startsWith('/');
      const skill = item.text.startsWith('$');
      // For a skill, color only the `$name` head; the args stay default white.
      const sp = item.text.indexOf(' ');
      const head = sp === -1 ? item.text : item.text.slice(0, sp);
      const rest = sp === -1 ? '' : item.text.slice(sp);
      return (
        <Box
          borderStyle="single"
          borderColor={ACCENT}
          borderLeft={false}
          borderRight={false}
          width="100%"
        >
          {command ? (
            <Text color={COMMAND} bold>{item.text}</Text>
          ) : skill ? (
            <Text><Text color={SKILL} bold>{head}</Text>{rest}</Text>
          ) : (
            <>
              <Text color={ACCENT} bold>{'> '}</Text>
              <Text>{item.text}</Text>
            </>
          )}
        </Box>
      );
    }
    case 'assistant':
      return <Markdown text={item.text} />;
    case 'notice':
      return <Text color={NOTICE_COLOR[item.tone]}>{item.text}</Text>;
    case 'plan':
      return (
        <Box flexDirection="column">
          <Text bold>Plan</Text>
          {item.steps.map(step => (
            <Text key={step.id} dimColor>
              {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▶' : '•'} {step.text}
            </Text>
          ))}
        </Box>
      );
    case 'tool': {
      const arrow = item.phase === 'request' ? '→' : item.isError ? '✗' : '←';
      const color = item.isError ? 'red' : 'gray';
      return (
        <Text color={color}>
          {arrow} {item.tool}{item.toolKind ? ` [${item.toolKind}]` : ''}: {item.summary}
        </Text>
      );
    }
    case 'verification':
      return (
        <Text color={item.passed ? 'green' : 'yellow'}>
          {item.passed ? '✓ verified' : '⚠ not verified'}: {item.notes}
        </Text>
      );
    case 'info':
      // The `/command` echo above already labels this block, so the title is
      // not repeated — just the lines.
      return (
        <Box flexDirection="column">
          {item.lines.map((line, i) => (
            <Text key={i} color={DIM}>{line}</Text>
          ))}
        </Box>
      );
    default:
      return null;
  }
}

export function Transcript({ items }: { items: TranscriptItem[] }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map(item => (
        <Box
          key={item.id}
          marginTop={item.kind === 'user' || item.kind === 'verification' ? 1 : 0}
          marginBottom={item.kind === 'plan' ? 1 : 0}
        >
          <TranscriptRow item={item} />
        </Box>
      ))}
    </Box>
  );
}
