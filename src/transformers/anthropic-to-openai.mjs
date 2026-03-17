import { log } from '../utils/logger.mjs';

function logDroppedAnthropicField(field, reason = '') {
  const suffix = reason ? ` (${reason})` : '';
  log('CONVERT', `Dropping Anthropic field '${field}' for OpenAI compatibility${suffix}`);
}

function createUnsupportedBlockTracker(scopeLabel) {
  const seen = new Set();
  return (blockType, reason = '') => {
    const key = `${blockType}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    const suffix = reason ? ` (${reason})` : '';
    log('CONVERT', `Dropping Anthropic ${scopeLabel} block '${blockType}'${suffix}`);
  };
}

function toOpenAIImagePart(block, onDrop) {
  const source = block?.source;
  if (!source || typeof source !== 'object') {
    onDrop('image', 'missing source');
    return null;
  }

  if (source.type === 'base64' && source.media_type && source.data) {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${source.media_type};base64,${source.data}`,
      },
    };
  }

  if (source.type === 'url' && source.url) {
    return {
      type: 'image_url',
      image_url: {
        url: source.url,
      },
    };
  }

  onDrop('image', `unsupported source type '${source.type || 'unknown'}'`);
  return null;
}

function convertBlocksToOpenAIContentParts(blocks, { allowImages, scopeLabel }) {
  const parts = [];
  const onDrop = createUnsupportedBlockTracker(scopeLabel);

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    switch (block.type) {
      case 'text':
        if (block.text != null && block.text !== '') {
          parts.push({ type: 'text', text: String(block.text) });
        }
        break;
      case 'image':
        if (!allowImages) {
          onDrop('image', 'images are only forwarded for user content');
          break;
        }
        {
          const imagePart = toOpenAIImagePart(block, onDrop);
          if (imagePart) parts.push(imagePart);
        }
        break;
      case 'thinking':
        onDrop('thinking', 'no OpenAI chat equivalent');
        break;
      case 'tool_use':
      case 'tool_result':
        // handled by the caller
        break;
      default:
        onDrop(block.type || 'unknown');
        break;
    }
  }

  return parts;
}

function materializeOpenAIContent(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  if (parts.every(part => part.type === 'text')) {
    return parts.map(part => part.text).join('\n');
  }
  return parts;
}

function extractSystemMessage(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return undefined;

  const onDrop = createUnsupportedBlockTracker('system');
  const textBlocks = [];

  for (const block of system) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text != null && block.text !== '') {
      textBlocks.push(String(block.text));
      continue;
    }
    if (block.type === 'thinking') {
      onDrop('thinking', 'no OpenAI system equivalent');
      continue;
    }
    onDrop(block.type || 'unknown');
  }

  return textBlocks.length > 0 ? textBlocks.join('\n') : undefined;
}

function extractToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const textParts = [];
  const unsupportedTypes = new Set();

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text != null && block.text !== '') {
      textParts.push(String(block.text));
    } else if (block.type) {
      unsupportedTypes.add(block.type);
    }
  }

  if (textParts.length > 0) {
    const text = textParts.join('\n');
    if (unsupportedTypes.size === 0) return text;
    return `${text}\n[Unsupported tool_result block types omitted: ${[...unsupportedTypes].join(', ')}]`;
  }
  if (unsupportedTypes.size > 0) {
    return `[Unsupported tool_result block types omitted: ${[...unsupportedTypes].join(', ')}]`;
  }

  return '';
}

function mapAnthropicToolChoice(toolChoice, hasTools) {
  if (toolChoice == null) return undefined;
  if (!hasTools) {
    logDroppedAnthropicField('tool_choice', 'no tools were provided');
    return undefined;
  }

  const normalized = typeof toolChoice === 'string' ? { type: toolChoice } : toolChoice;
  const type = normalized?.type;

  switch (type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'any':
      return 'required';
    case 'tool':
      if (normalized.name) {
        return {
          type: 'function',
          function: { name: normalized.name },
        };
      }
      logDroppedAnthropicField('tool_choice', 'specific tool choice is missing a name');
      return undefined;
    default:
      logDroppedAnthropicField('tool_choice', `unsupported value '${type || typeof toolChoice}'`);
      return undefined;
  }
}

/**
 * Anthropic Messages API 형식 → OpenAI Chat Completions 형식 변환
 *
 * 모델명 기반 라우팅: /v1/messages 로 들어온 요청이지만
 * 모델이 OpenAI 계열이면 이 변환기를 거쳐 Azure OpenAI로 전송
 */
export function convertAnthropicToOpenAI(body) {
  const messages = [];

  // system 필드 → OpenAI system 메시지
  const systemContent = extractSystemMessage(body.system);
  if (systemContent) {
    messages.push({ role: 'system', content: systemContent });
  }

  // messages 변환
  for (const msg of body.messages || []) {
    const role = msg.role;

    if (typeof msg.content === 'string') {
      messages.push({ role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      messages.push({ role, content: '' });
      continue;
    }

    const toolUseBlocks = msg.content.filter(block => block?.type === 'tool_use');
    const toolResultBlocks = msg.content.filter(block => block?.type === 'tool_result');
    const remainingParts = convertBlocksToOpenAIContentParts(msg.content, {
      allowImages: role === 'user',
      scopeLabel: `${role} message`,
    });
    const remainingContent = materializeOpenAIContent(remainingParts);

    if (toolResultBlocks.length > 0) {
      for (const tr of toolResultBlocks) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: extractToolResultContent(tr.content),
        });
      }
      if (remainingParts.length > 0) {
        messages.push({ role: 'user', content: remainingContent });
      }
      continue;
    }

    if (toolUseBlocks.length > 0 && role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: remainingParts.length > 0 ? remainingContent : null,
        tool_calls: toolUseBlocks.map(block => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        })),
      });
      continue;
    }

    messages.push({ role, content: remainingContent });
  }

  const result = {
    model: body.model,
    messages,
    stream: body.stream || false,
  };

  if (body.max_tokens != null) result.max_tokens = body.max_tokens;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.top_k != null) {
    logDroppedAnthropicField('top_k', 'no OpenAI chat equivalent');
  }
  if (body.stop != null) {
    result.stop = body.stop;
  } else if (body.stop_sequences != null) {
    result.stop = body.stop_sequences;
  }

  // tools 변환 (Anthropic tools → OpenAI functions)
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {},
      },
    }));
  }

  const mappedToolChoice = mapAnthropicToolChoice(body.tool_choice, Array.isArray(result.tools) && result.tools.length > 0);
  if (mappedToolChoice !== undefined) {
    result.tool_choice = mappedToolChoice;
  }

  if (body.metadata?.user_id) {
    result.user = String(body.metadata.user_id);
  }
  if (body.metadata != null) {
    const metadataKeys = Object.keys(body.metadata || {}).filter(key => key !== 'user_id');
    if (metadataKeys.length > 0) {
      logDroppedAnthropicField('metadata', `unsupported keys: ${metadataKeys.join(', ')}`);
    }
  }

  if (body.thinking != null) {
    logDroppedAnthropicField('thinking', 'no OpenAI chat equivalent');
  }

  log('CONVERT', `Anthropic → OpenAI: ${body.messages?.length ?? 0} msgs, model=${body.model}`);
  return result;
}

/**
 * 이 모델이 OpenAI 라우팅 대상인지 확인
 * modelNameMap 적용 후의 모델명으로 비교
 */
export function isOpenAIModel(modelName, config) {
  if (!modelName) return false;
  const resolved = config.modelNameMap?.[modelName] ?? modelName;
  return config.openAIModels?.includes(resolved) || config.openAIModels?.includes(modelName);
}
