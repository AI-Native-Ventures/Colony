function isPdfWhitespace(byte: number): boolean {
  return (
    byte === 0 ||
    byte === 9 ||
    byte === 10 ||
    byte === 12 ||
    byte === 13 ||
    byte === 32
  );
}

function hexDigit(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

export function ascii85Transform(): TransformStream<Uint8Array, Uint8Array> {
  const group: number[] = [];
  let ended = false;
  let tilde = false;
  const emitGroup = (output: number[], final: boolean) => {
    const originalLength = group.length;
    if (final && originalLength === 1)
      throw new Error("PDF ASCII85 stream is invalid");
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    if (value > 0xffff_ffff) throw new Error("PDF ASCII85 stream is invalid");
    const bytes = [
      Math.floor(value / 0x1_00_00_00) & 0xff,
      Math.floor(value / 0x1_00_00) & 0xff,
      Math.floor(value / 0x1_00) & 0xff,
      value & 0xff,
    ];
    output.push(...bytes.slice(0, final ? originalLength - 1 : 4));
    group.length = 0;
  };
  return new TransformStream({
    transform(chunk, controller) {
      const output: number[] = [];
      for (const byte of chunk) {
        if (ended) {
          if (!isPdfWhitespace(byte))
            throw new Error("PDF ASCII85 stream is invalid");
          continue;
        }
        if (tilde) {
          if (byte !== 0x3e) throw new Error("PDF ASCII85 stream is invalid");
          if (group.length > 0) emitGroup(output, true);
          ended = true;
          tilde = false;
          continue;
        }
        if (isPdfWhitespace(byte)) continue;
        if (byte === 0x7e) {
          tilde = true;
          continue;
        }
        if (byte === 0x7a && group.length === 0) {
          output.push(0, 0, 0, 0);
          continue;
        }
        if (byte < 0x21 || byte > 0x75)
          throw new Error("PDF ASCII85 stream is invalid");
        group.push(byte - 0x21);
        if (group.length === 5) emitGroup(output, false);
      }
      if (output.length > 0) controller.enqueue(new Uint8Array(output));
    },
    flush() {
      if (!ended || tilde || group.length > 0)
        throw new Error("PDF ASCII85 stream is invalid");
    },
  });
}

export function asciiHexTransform(): TransformStream<Uint8Array, Uint8Array> {
  let ended = false;
  let highNibble: number | null = null;
  return new TransformStream({
    transform(chunk, controller) {
      const output: number[] = [];
      for (const byte of chunk) {
        if (ended) {
          if (!isPdfWhitespace(byte))
            throw new Error("PDF ASCIIHex stream is invalid");
          continue;
        }
        if (isPdfWhitespace(byte)) continue;
        if (byte === 0x3e) {
          if (highNibble !== null) output.push(highNibble * 16);
          highNibble = null;
          ended = true;
          continue;
        }
        const digit = hexDigit(byte);
        if (digit < 0) throw new Error("PDF ASCIIHex stream is invalid");
        if (highNibble === null) highNibble = digit;
        else {
          output.push(highNibble * 16 + digit);
          highNibble = null;
        }
      }
      if (output.length > 0) controller.enqueue(new Uint8Array(output));
    },
    flush() {
      if (!ended) throw new Error("PDF ASCIIHex stream is invalid");
    },
  });
}

export function lzwTransform(
  earlyChange: number,
): TransformStream<Uint8Array, Uint8Array> {
  const dictionaryValues = new Uint8Array(4096);
  const dictionaryLengths = new Uint16Array(4096);
  const dictionaryPrevCodes = new Uint16Array(4096);
  const currentSequence = new Uint8Array(4096);
  for (let index = 0; index < 256; index += 1) {
    dictionaryValues[index] = index;
    dictionaryLengths[index] = 1;
  }
  let bitBuffer = 0;
  let bitCount = 0;
  let codeLength = 9;
  let nextCode = 258;
  let previousCode: number | null = null;
  let ended = false;

  const reset = () => {
    codeLength = 9;
    nextCode = 258;
    previousCode = null;
  };
  const readSequence = (code: number): number => {
    if (code < 256) {
      currentSequence[0] = code;
      return 1;
    }
    if (code < nextCode && dictionaryLengths[code] > 0) {
      const length = dictionaryLengths[code];
      let current = code;
      for (let index = length - 1; index >= 0; index -= 1) {
        currentSequence[index] = dictionaryValues[current];
        current = dictionaryPrevCodes[current];
      }
      return length;
    }
    if (code === nextCode && previousCode !== null) {
      const length = readSequence(previousCode);
      if (length >= currentSequence.length)
        throw new Error("PDF LZW stream is invalid");
      currentSequence[length] = currentSequence[0];
      return length + 1;
    }
    throw new Error("PDF LZW stream is invalid");
  };

  return new TransformStream({
    transform(chunk, controller) {
      const output: number[] = [];
      for (const byte of chunk) {
        if (ended) break;
        bitBuffer = bitBuffer * 256 + byte;
        bitCount += 8;
        while (bitCount >= codeLength && !ended) {
          bitCount -= codeLength;
          const divisor = 2 ** bitCount;
          const code = Math.floor(bitBuffer / divisor) & (2 ** codeLength - 1);
          bitBuffer %= divisor;
          if (code === 256) {
            reset();
            continue;
          }
          if (code === 257) {
            ended = true;
            continue;
          }
          const sequenceLength = readSequence(code);
          if (previousCode !== null && nextCode < 4096) {
            dictionaryPrevCodes[nextCode] = previousCode;
            dictionaryLengths[nextCode] = dictionaryLengths[previousCode] + 1;
            dictionaryValues[nextCode] = currentSequence[0];
            nextCode += 1;
            if (codeLength < 12 && nextCode + earlyChange === 2 ** codeLength) {
              codeLength += 1;
            }
          }
          previousCode = code;
          for (let index = 0; index < sequenceLength; index += 1) {
            output.push(currentSequence[index]);
            if (output.length >= 8_192) {
              controller.enqueue(new Uint8Array(output));
              output.length = 0;
            }
          }
        }
      }
      if (output.length > 0) controller.enqueue(new Uint8Array(output));
    },
    flush() {
      if (!ended) throw new Error("PDF LZW stream is invalid");
    },
  });
}

export function runLengthTransform(): TransformStream<Uint8Array, Uint8Array> {
  let ended = false;
  let literalRemaining = 0;
  let repeatRemaining = 0;
  return new TransformStream({
    transform(chunk, controller) {
      const output: number[] = [];
      for (const byte of chunk) {
        if (ended) break;
        if (literalRemaining > 0) {
          output.push(byte);
          literalRemaining -= 1;
          continue;
        }
        if (repeatRemaining > 0) {
          output.push(...Array(repeatRemaining).fill(byte));
          repeatRemaining = 0;
          continue;
        }
        if (byte === 128) {
          ended = true;
        } else if (byte <= 127) {
          literalRemaining = byte + 1;
        } else {
          repeatRemaining = 257 - byte;
        }
      }
      if (output.length > 0) controller.enqueue(new Uint8Array(output));
    },
    flush() {
      if (!ended || literalRemaining > 0 || repeatRemaining > 0) {
        throw new Error("PDF RunLength stream is invalid");
      }
    },
  });
}
