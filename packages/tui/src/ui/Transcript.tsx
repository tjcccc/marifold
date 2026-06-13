import React from 'react';
import { Box, Text } from 'ink';
import type { NoticeTone, TranscriptItem } from '../core/appState.js';

const NOTICE_COLOR: Record<NoticeTone, string> = {
  info: 'gray',
  warn: 'yellow',
  error: 'red',
};

export function TranscriptRow({ item }: { item: TranscriptItem }): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      return (
        <Box>
          <Text color="green">{'› '}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      return <Text>{item.text}</Text>;
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
    default:
      return null;
  }
}

export function Transcript({ items }: { items: TranscriptItem[] }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map(item => (
        <Box key={item.id} marginBottom={item.kind === 'plan' ? 1 : 0}>
          <TranscriptRow item={item} />
        </Box>
      ))}
    </Box>
  );
}
