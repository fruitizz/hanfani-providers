import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client'
import {
  approvalResolved,
  gateOpened,
  type GateResolution,
  type Provider,
  type ResumeHandle,
  type Message,
} from '@hanfani/core'

const LEAD = {
  from: 'ivan@acme.ru',
  subject: 'Order: 10 units',
  summary: 'Customer wants to order 10 units; asks about delivery time.',
}

const DRAFT = { threadId: 'thread_demo', body: 'Thanks for reaching out — here is a reply.' }

function textChunk(delta: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CHUNK,
    role: 'assistant',
    messageId: crypto.randomUUID(),
    delta,
  } as BaseEvent
}

// Yields the tool-call events and RETURNS the toolCallId (so run() can reference it in the
// GATE_OPENED event). `yield* toolCall(...)` evaluates to that returned id.
async function* toolCall(
  name: string,
  args: Record<string, unknown>
): AsyncGenerator<BaseEvent, string> {
  const toolCallId = crypto.randomUUID()
  yield {
    type: EventType.TOOL_CALL_START,
    parentMessageId: crypto.randomUUID(),
    toolCallId,
    toolCallName: name,
  } as BaseEvent
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) } as BaseEvent
  yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent
  return toolCallId
}

// The fake "model": turn 1 streams text → renderLead → saveDraft approval → GATE_OPENED
// (the suspend point). resume() emits the post-approval done text. `approvalNames` comes from
// the agent definition, not a hardcode. run() keeps the message-detected resume path for
// back-compat with the old client; resume() is the new explicit v2 path.
export function createMockInboxProvider(approvalNames: readonly string[]): Provider {
  return {
    async *run(runInput: RunAgentInput): AsyncIterable<BaseEvent> {
      const messages = (runInput?.messages ?? []) as Message[]

      if (approvalResolved(messages, approvalNames)) {
        yield textChunk('Draft saved to Gmail.')
        return
      }

      yield textChunk('Checking inbox… found a lead.')
      yield* toolCall('renderLead', LEAD)
      const saveDraftId = yield* toolCall('saveDraft', DRAFT)
      yield gateOpened({
        gateKind: 'approval',
        toolName: 'saveDraft',
        toolCallId: saveDraftId,
        proposedArtifact: DRAFT,
      })
    },

    async *resume(_handle: ResumeHandle, resolution: GateResolution): AsyncIterable<BaseEvent> {
      if (resolution.decision === 'rejected') {
        yield textChunk('The human rejected the draft; nothing was saved.')
        return
      }
      yield textChunk('Draft saved to Gmail.')
    },
  }
}
