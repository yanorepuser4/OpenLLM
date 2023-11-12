/**
 * @typedef {{
 * event: string | null;
 * data: string;
 * raw: string[];
 * }} ServerSentEvent
 * */

/**
 * @typedef {string | ArrayBuffer | Uint8Array | Buffer | null | undefined} Bytes
 * Represents a type that can be a string, ArrayBuffer, Uint8Array, Buffer, null, or undefined.
 */

/**
 * @param {string} string
 * @param {string} delimiter
 * @returns {[string, string, string]}
 * */
function partition(str, delimiter) {
  const index = str.indexOf(delimiter);
  if (index !== -1) {
    return [str.substring(0, index), delimiter, str.substring(index + delimiter.length)];
  }

  return [str, '', ''];
}

export class Stream {
  /**
    * Creates an instance of Stream.
    * @param {() => AsyncIterator<Item>} iterator A function returning an async iterator for the items.
    * @param {AbortController} controller An AbortController for controlling the stream.
    */
  constructor(iterator, controller) {
    this.iterator = iterator;
    /**
     * @type {AbortController}
     * */
    this.controller = controller;
  }
  /**
   * Creates a Stream from a Server-Sent Events (SSE) response.
   * @template Item
   * @param {Response} response The SSE response.
   * @param {AbortController} controller An AbortController for controlling the stream.
   * @returns {Stream<Item>} A new Stream instance.
   */
  static fromSSEResponse(response, controller) {
    let consumed = false;
    const decoder = new SSEDecoder();

    /**
     * @returns {AsyncGenerator<ServerSentEvent, void, unknown>}
     * */
    async function* iterMessages() {
      if (!response.body) {
        controller.abort();
        throw new Error(`Attempted to iterate over a response with no body`);
      }

      const lineDecoder = new LineDecoder();

      const iter = readableStreamAsyncIterable(response.body);
      for await (const chunk of iter) {
        for (const line of lineDecoder.decode(chunk)) {
          const sse = decoder.decode(line);
          if (sse) yield sse;
        }
      }

      for (const line of lineDecoder.flush()) {
        const sse = decoder.decode(line);
        if (sse) yield sse;
      }
    }

    /**
     * @returns {AsyncGenerator<Item, any, undefined>}*/
    async function* iterator() {
      if (consumed) {
        throw new Error('Cannot iterate over a consumed stream, use `.tee()` to split the stream.');
      }
      consumed = true;
      let done = false;
      try {
        for await (const sse of iterMessages()) {
          if (done) continue;

          if (sse.data.startsWith('[DONE]')) {
            done = true;
            continue;
          }

          if (sse.event === null) {
            let data;

            try {
              data = JSON.parse(sse.data);
            } catch (e) {
              console.error(`Could not parse message into JSON:`, sse.data);
              console.error(`From chunk:`, sse.raw);
              throw e;
            }

            if (data && data.error) {
              throw new APIError(undefined, data.error, undefined, undefined);
            }

            yield data;
          }
        }
        done = true;
      } catch (e) {
        // If the user calls `stream.controller.abort()`, we should exit without throwing.
        if (e instanceof Error && e.name === 'AbortError') return;
        throw e;
      } finally {
        // If the user `break`s, abort the ongoing request.
        if (!done) controller.abort();
      }
    }

    return new Stream(iterator, controller);
  }

  /**
   * Generates a Stream from a newline-separated ReadableStream where each item is a JSON value.
   * @template Item
   * @param {ReadableStream} readableStream A ReadableStream instance.
   * @param {AbortController} controller An AbortController for controlling the stream.
   * @returns {Stream<Item>} A new Stream instance.
   */
  static fromReadableStream<Item>(readableStream, controller) {
    let consumed = false;

    /**
     * @returns {AsyncGenerator<string, void, unknown>}*/
    async function* iterLines() {
      const lineDecoder = new LineDecoder();

      const iter = readableStreamAsyncIterable < Bytes > (readableStream);
      for await (const chunk of iter) {
        for (const line of lineDecoder.decode(chunk)) {
          yield line;
        }
      }

      for (const line of lineDecoder.flush()) {
        yield line;
      }
    }

    /**
     * @returns {AsyncIterator<Item, any, undefined>}*/
    async function* iterator() {
      if (consumed) {
        throw new Error('Cannot iterate over a consumed stream, use `.tee()` to split the stream.');
      }
      consumed = true;
      let done = false;
      try {
        for await (const line of iterLines()) {
          if (done) continue;
          if (line) yield JSON.parse(line);
        }
        done = true;
      } catch (e) {
        // If the user calls `stream.controller.abort()`, we should exit without throwing.
        if (e instanceof Error && e.name === 'AbortError') return;
        throw e;
      } finally {
        // If the user `break`s, abort the ongoing request.
        if (!done) controller.abort();
      }
    }

    return new Stream(iterator, controller);
  }

  /**
   * Returns the async iterator for this stream.
   * @returns {AsyncIterator<Item>} The async iterator.
   */
  [Symbol.asyncIterator]() {
    return this.iterator();
  }
}


class SSEDecoder {
  constructor() {
    /**
      * @type {string[]}
      */
    this.data = [];
    /**
      * @type {string | null}
      */
    this.event = null;
    /**
      * @type {string[]}
      */
    this.chunks = [];
  }
  /**
    * @param {string} line
    * @returns {ServerSentEvent | null}*/
  decode(line) {
    if (line.startsWith('\r')) {
      line = line.substring(0, line.length - 1);
    }
    if (!line) {
      // empty line
      if (!this.event && !this.data.length) return null
      /**@type {ServerSentEvent} */
      const sse = { event: this.event, data: this.data.join('\n'), raw: this.chunks };

      this.event = null;
      this.data = [];
      this.chunks = [];
      return sse;
    }

    this.chunks.push(line);
    if (line.startsWith(':')) {
      // comment
      return null;
    }

    let [fieldName, _, value] = partition(line, ':');
    if (value.startsWith(' ')) {
      value = value.substring(1);
    }

    if (fieldName === 'event') {
      this.event = value;
    } else if (fieldName === 'data') {
      this.data.push(value);
    }
    return null;
  }
}

/**
  * A re-implementation of httpx's `LineDecoder` in Python that handles incrementally
  * reading lines from text.
  *
  * https://github.com/encode/httpx/blob/920333ea98118e9cf617f246905d7b202510941c/httpx/_decoders.py#L258
  */
class LineDecoder {
  static NEWLINE_CHARS = new Set(['\n', '\r', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029']);
  static NEWLINE_REGEXP = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/g;
  constructor() {
    /**
      * @type {string[]}
      */
    this.buffer = [];
    /**
      * @type {boolean}
      */
    this.trailingCR = false;
  }

  /**
    *
    * @param {Bytes} chunk
    * @returns {string[]}
    */
  decode(chunk) {
    let text = this.decodeText(chunk);

    if (this.trailingCR) {
      text = '\r' + text;
      this.trailingCR = false;
    }
    if (text.endsWith('\r')) {
      this.trailingCR = true;
      text = text.slice(0, -1);
    }

    if (!text) return []

    const trailingNewline = LineDecoder.NEWLINE_CHARS.has(text[text.length - 1] || '');
    let lines = text.split(LineDecoder.NEWLINE_REGEXP);

    if (lines.length === 1 && !trailingNewline) {
      this.buffer.push(lines[0] ?? '');
      return [];
    }

    if (this.buffer.length > 0) {
      lines = [this.buffer.join('') + lines[0], ...lines.slice(1)];
      this.buffer = [];
    }

    if (!trailingNewline) {
      this.buffer = [lines.pop() || ''];
    }

    return lines;
  }
  /**
    *
    * @param {Bytes} chunk
    * @returns {string]}
    */
  decodeText(bytes) {
    if (bytes == null) return '';
    if (typeof bytes === 'string') return bytes;

    // Node:
    if (typeof Buffer !== 'undefined') {
      if (Buffer.isBuffer(bytes)) {
        return bytes.toString();
      }
      if (bytes instanceof Uint8Array) {
        return Buffer.from(bytes).toString();
      }

      throw new Error(
        `Unexpected: received non-Uint8Array (${bytes.constructor.name}) stream chunk in an environment with a global "Buffer" defined, which this library assumes to be Node. Please report this error.`,
      );
    }

    // Browser
    if (typeof TextDecoder !== 'undefined') {
      if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) {
        this.textDecoder = this.textDecoder || new TextDecoder('utf8');
        return this.textDecoder.decode(bytes);
      }

      throw new Error(
        `Unexpected: received non-Uint8Array/ArrayBuffer (${bytes.constructor.name
        }) in a web platform. Please report this error.`,
      );
    }

    throw new Error(
      `Unexpected: neither Buffer nor TextDecoder are available as globals. Please report this error.`,
    );
  }
  /**
    * Flushes the internal buffer and returns its contents.
    * @returns {string[]} The contents of the buffer.
    */
  flush() {
    if (!this.buffer.length && !this.trailingCR) return []

    const lines = [this.buffer.join('')];
    this.buffer = [];
    this.trailingCR = false;
    return lines;
  }
}
