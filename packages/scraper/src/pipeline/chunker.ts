const MAX_TOKENS = 500;
const OVERLAP_TOKENS = 50;

// Rough token estimate: ~4 chars per token (GPT-style)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  heading: string;
  content: string;
  tokens: number;
}

/**
 * Split a markdown document into chunks along heading boundaries.
 * Rules:
 * - Never split inside a fenced code block
 * - Keep code blocks with their preceding paragraph
 * - If a chunk exceeds MAX_TOKENS, split at paragraph boundaries with overlap
 */
export function chunkMarkdown(markdown: string, title: string): Chunk[] {
  const lines = markdown.split("\n");
  const sections: Array<{ heading: string; lines: string[] }> = [];

  let currentHeading = title;
  let currentLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track code fence boundaries
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      currentLines.push(line);
      continue;
    }

    // Split on ATX headings (only when not inside a code block)
    if (!inCodeBlock && /^#{1,3}\s+/.test(line)) {
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, lines: [...currentLines] });
      }
      currentHeading = line.replace(/^#{1,3}\s+/, "").trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Push final section
  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, lines: [...currentLines] });
  }

  const chunks: Chunk[] = [];

  for (const section of sections) {
    const content = section.lines.join("\n").trim();
    if (!content) continue;

    const tokens = estimateTokens(content);

    if (tokens <= MAX_TOKENS) {
      chunks.push({ heading: section.heading, content, tokens });
    } else {
      // Split oversized section at paragraph boundaries
      const subChunks = splitAtParagraphs(section.heading, content);
      chunks.push(...subChunks);
    }
  }

  return chunks;
}

function splitAtParagraphs(heading: string, content: string): Chunk[] {
  const paragraphs = content.split(/\n{2,}/);
  const chunks: Chunk[] = [];

  let buffer: string[] = [];
  let bufferTokens = 0;
  let inCode = false;
  let codeBuffer: string[] = [];

  for (const para of paragraphs) {
    // Keep code blocks intact with their preceding paragraph
    if (para.trimStart().startsWith("```")) {
      inCode = !inCode;
      codeBuffer.push(para);
      if (!inCode) {
        // End of code block — flush with preceding buffer
        const codeContent = codeBuffer.join("\n\n");
        buffer.push(codeContent);
        bufferTokens += estimateTokens(codeContent);
        codeBuffer = [];
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(para);
      continue;
    }

    const paraTokens = estimateTokens(para);

    if (bufferTokens + paraTokens > MAX_TOKENS && buffer.length > 0) {
      // Emit current chunk
      const chunkContent = buffer.join("\n\n");
      chunks.push({ heading, content: chunkContent, tokens: bufferTokens });

      // Start new buffer with overlap: keep last paragraph
      const lastPara = buffer[buffer.length - 1] ?? "";
      const overlapTokens = estimateTokens(lastPara);
      if (overlapTokens < OVERLAP_TOKENS) {
        buffer = [lastPara];
        bufferTokens = overlapTokens;
      } else {
        buffer = [];
        bufferTokens = 0;
      }
    }

    buffer.push(para);
    bufferTokens += paraTokens;
  }

  // Flush remaining
  if (buffer.length > 0) {
    chunks.push({ heading, content: buffer.join("\n\n"), tokens: bufferTokens });
  }

  return chunks;
}
