"use strict";

(function () {
    const dataCodewords = [0, 19, 34, 55, 80, 108, 136];
    const errorCodewords = [0, 7, 10, 15, 20, 26, 18];
    const dataBlockSizes = [[], [19], [34], [55], [80], [108], [68, 68]];
    const alignmentCenters = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

    function appendBits(bits, value, length) {
        for (let index = length - 1; index >= 0; index--) {
            bits.push((value >>> index) & 1);
        }
    }

    function multiply(a, b) {
        let product = 0;
        while (b !== 0) {
            if (b & 1) product ^= a;
            a <<= 1;
            if (a & 0x100) a ^= 0x11d;
            b >>>= 1;
        }
        return product;
    }

    function errorCorrection(data, degree) {
        const divisor = new Array(degree).fill(0);
        divisor[degree - 1] = 1;
        let root = 1;
        for (let index = 0; index < degree; index++) {
            for (let offset = 0; offset < degree; offset++) {
                divisor[offset] = multiply(divisor[offset], root);
                if (offset + 1 < degree) divisor[offset] ^= divisor[offset + 1];
            }
            root = multiply(root, 2);
        }

        const remainder = new Array(degree).fill(0);
        for (const byte of data) {
            const factor = byte ^ remainder[0];
            remainder.shift();
            remainder.push(0);
            for (let index = 0; index < degree; index++) {
                remainder[index] ^= multiply(divisor[index], factor);
            }
        }
        return remainder;
    }

    function encodeData(text) {
        const bytes = Array.from(new TextEncoder().encode(text));
        let version = 1;
        for (; version <= 6; version++) {
            if (4 + 8 + bytes.length * 8 <= dataCodewords[version] * 8) break;
        }
        if (version > 6) throw new RangeError("The invite link is too long to encode.");

        const bits = [];
        appendBits(bits, 4, 4);
        appendBits(bits, bytes.length, 8);
        for (const byte of bytes) appendBits(bits, byte, 8);
        const capacity = dataCodewords[version] * 8;
        appendBits(bits, 0, Math.min(4, capacity - bits.length));
        while (bits.length % 8 !== 0) bits.push(0);

        const data = [];
        for (let index = 0; index < bits.length; index += 8) {
            let byte = 0;
            for (let offset = 0; offset < 8; offset++) byte = (byte << 1) | bits[index + offset];
            data.push(byte);
        }
        for (let pad = 0; data.length < dataCodewords[version]; pad++) {
            data.push(pad % 2 === 0 ? 0xec : 0x11);
        }

        const blocks = [];
        let offset = 0;
        for (const blockSize of dataBlockSizes[version]) {
            const block = data.slice(offset, offset + blockSize);
            blocks.push({ data: block, ecc: errorCorrection(block, errorCodewords[version]) });
            offset += blockSize;
        }
        const codewords = [];
        const longestBlock = Math.max(...dataBlockSizes[version]);
        for (let index = 0; index < longestBlock; index++) {
            for (const block of blocks) {
                if (index < block.data.length) codewords.push(block.data[index]);
            }
        }
        for (let index = 0; index < errorCodewords[version]; index++) {
            for (const block of blocks) codewords.push(block.ecc[index]);
        }
        return { version, codewords };
    }

    function createMatrix(text) {
        const encoded = encodeData(text);
        const size = encoded.version * 4 + 17;
        const modules = Array.from({ length: size }, () => new Array(size).fill(false));
        const functionModules = Array.from({ length: size }, () => new Array(size).fill(false));

        function setFunction(x, y, dark) {
            if (x < 0 || y < 0 || x >= size || y >= size) return;
            modules[y][x] = dark;
            functionModules[y][x] = true;
        }

        function drawFinder(centerX, centerY) {
            for (let dy = -1; dy <= 7; dy++) {
                for (let dx = -1; dx <= 7; dx++) {
                    const inFinder = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
                    const dark = inFinder && (
                        dx === 0 || dx === 6 || dy === 0 || dy === 6 ||
                        (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)
                    );
                    setFunction(centerX + dx, centerY + dy, dark);
                }
            }
        }

        drawFinder(0, 0);
        drawFinder(size - 7, 0);
        drawFinder(0, size - 7);

        for (const centerY of alignmentCenters[encoded.version]) {
            for (const centerX of alignmentCenters[encoded.version]) {
                if (functionModules[centerY][centerX]) continue;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        setFunction(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                    }
                }
            }
        }

        for (let index = 8; index < size - 8; index++) {
            setFunction(index, 6, index % 2 === 0);
            setFunction(6, index, index % 2 === 0);
        }

        const formatData = (1 << 3);
        let remainder = formatData;
        for (let index = 0; index < 10; index++) {
            remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
        }
        const formatBits = ((formatData << 10) | remainder) ^ 0x5412;
        for (let index = 0; index <= 5; index++) setFunction(8, index, ((formatBits >>> index) & 1) !== 0);
        setFunction(8, 7, ((formatBits >>> 6) & 1) !== 0);
        setFunction(8, 8, ((formatBits >>> 7) & 1) !== 0);
        setFunction(7, 8, ((formatBits >>> 8) & 1) !== 0);
        for (let index = 9; index < 15; index++) setFunction(14 - index, 8, ((formatBits >>> index) & 1) !== 0);
        for (let index = 0; index < 8; index++) setFunction(size - 1 - index, 8, ((formatBits >>> index) & 1) !== 0);
        for (let index = 8; index < 15; index++) setFunction(8, size - 15 + index, ((formatBits >>> index) & 1) !== 0);
        setFunction(8, size - 8, true);

        const bits = [];
        for (const byte of encoded.codewords) appendBits(bits, byte, 8);
        let bitIndex = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            const upward = ((right + 1) & 2) === 0;
            for (let vertical = 0; vertical < size; vertical++) {
                const y = upward ? size - 1 - vertical : vertical;
                for (let side = 0; side < 2; side++) {
                    const x = right - side;
                    if (functionModules[y][x]) continue;
                    let dark = bitIndex < bits.length && bits[bitIndex] !== 0;
                    if ((x + y) % 2 === 0) dark = !dark;
                    modules[y][x] = dark;
                    bitIndex++;
                }
            }
        }
        return modules;
    }

    window.renderRoomQr = function (canvas, text) {
        const matrix = createMatrix(text);
        const quietZone = 4;
        const moduleScale = 8;
        const dimension = (matrix.length + quietZone * 2) * moduleScale;
        canvas.width = dimension;
        canvas.height = dimension;
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, dimension, dimension);
        context.fillStyle = "#111827";
        for (let y = 0; y < matrix.length; y++) {
            for (let x = 0; x < matrix.length; x++) {
                if (matrix[y][x]) {
                    context.fillRect((x + quietZone) * moduleScale, (y + quietZone) * moduleScale, moduleScale, moduleScale);
                }
            }
        }
    };
}());
