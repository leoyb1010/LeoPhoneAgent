const root = typeof global !== 'undefined'
  ? global
  : typeof globalThis !== 'undefined'
    ? globalThis
    : undefined;

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;

function isWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return false;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

if (typeof String.prototype.toWellFormed !== 'function') {
  Object.defineProperty(String.prototype, 'toWellFormed', {
    configurable: true,
    enumerable: false,
    value() {
      const value = String(this);
      let output = '';
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            output += value[index] + value[index + 1];
            index += 1;
          } else {
            output += '\ufffd';
          }
          continue;
        }
        output += code >= 0xdc00 && code <= 0xdfff ? '\ufffd' : value[index];
      }
      return output;
    },
    writable: true,
  });
}

if (typeof String.prototype.isWellFormed !== 'function') {
  Object.defineProperty(String.prototype, 'isWellFormed', {
    configurable: true,
    enumerable: false,
    value() {
      return isWellFormedString(String(this));
    },
    writable: true,
  });
}

if (!Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')) {
  Object.defineProperty(ArrayBuffer.prototype, 'resizable', {
    configurable: true,
    enumerable: false,
    get() {
      arrayBufferByteLength?.call(this);
      return false;
    },
  });
}

if (root && !Object.prototype.hasOwnProperty.call(root, 'SharedArrayBuffer')) {
  const sharedBuffers = new WeakSet();

  function SharedArrayBuffer(length) {
    const buffer = new ArrayBuffer(length);
    sharedBuffers.add(buffer);
    return buffer;
  }

  Object.defineProperty(SharedArrayBuffer.prototype, 'byteLength', {
    configurable: true,
    enumerable: false,
    get() {
      if (!sharedBuffers.has(this)) throw new TypeError('Invalid SharedArrayBuffer');
      return arrayBufferByteLength?.call(this) ?? 0;
    },
  });

  Object.defineProperty(SharedArrayBuffer.prototype, 'growable', {
    configurable: true,
    enumerable: false,
    get() {
      if (!sharedBuffers.has(this)) throw new TypeError('Invalid SharedArrayBuffer');
      return false;
    },
  });

  Object.defineProperty(root, 'SharedArrayBuffer', {
    configurable: true,
    enumerable: false,
    value: SharedArrayBuffer,
    writable: true,
  });
}
