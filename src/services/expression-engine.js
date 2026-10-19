const TOKEN_RE = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|===|!==|==|!=|<=|>=|&&|\|\||\*\*|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/%,!<>]/gy;
const FUNCTIONS = new Set(['min', 'max', 'sum', 'avg', 'mean', 'abs', 'round', 'floor', 'ceil', 'sqrt', 'pow', 'clamp', 'limit', 'scale', 'bit', 'if', 'coalesce', 'concat']);

function tokenize(input) {
  const tokens = [];
  const source = String(input || '');
  let cursor = 0;
  while (cursor < source.length) {
    TOKEN_RE.lastIndex = cursor;
    const match = TOKEN_RE.exec(source);
    if (!match) throw new Error(`Unsupported symbol in expression at position ${cursor + 1}.`);
    cursor = TOKEN_RE.lastIndex;
    const raw = match[0];
    if (/^\s+$/.test(raw)) continue;
    let type = 'operator';
    if (/^(?:\d|\.)/.test(raw)) type = 'number';
    else if (/^["']/.test(raw)) type = 'string';
    else if (/^[A-Za-z_]/.test(raw)) type = 'identifier';
    tokens.push({ type, value: raw, pos: cursor - raw.length });
  }
  tokens.push({ type: 'eof', value: '', pos: cursor });
  return tokens;
}

function decodeLiteral(raw) {
  if (raw[0] === '"') return JSON.parse(raw);
  return raw.slice(1, -1).replace(/\\(['\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

function parseExpression(input) {
  const tokens = tokenize(input);
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const match = (...values) => values.includes(peek().value) ? take() : null;
  const expect = value => { const token = match(value); if (!token) throw new Error(`Expected "${value}" at position ${peek().pos + 1}.`); return token; };

  function parsePrimary() {
    const token = take();
    if (token.type === 'number') return { type: 'literal', value: Number(token.value) };
    if (token.type === 'string') return { type: 'literal', value: decodeLiteral(token.value) };
    if (token.value === '(') { const expr = parseOr(); expect(')'); return expr; }
    if (token.type === 'identifier') {
      const name = token.value.toLowerCase();
      if (name === 'true') return { type: 'literal', value: true };
      if (name === 'false') return { type: 'literal', value: false };
      if (peek().value !== '(') throw new Error(`Identifier "${token.value}" is invalid without a function call. Use tag("TagID") to reference another tag.`);
      take();
      const args = [];
      if (peek().value !== ')') { do { args.push(parseOr()); } while (match(',')); }
      expect(')');
      if (name === 'tag') {
        if (args.length !== 1 || args[0].type !== 'literal' || typeof args[0].value !== 'string' || !args[0].value) throw new Error('tag() requires a Tag ID string, for example tag("temperature").');
      } else if (!FUNCTIONS.has(name)) throw new Error(`Function not allowed: ${token.value}.`);
      return { type: 'call', name, args };
    }
    throw new Error(`Incomplete expression near position ${token.pos + 1}.`);
  }
  function parseUnary() {
    if (match('!')) return { type: 'unary', op: '!', right: parseUnary() };
    if (match('-')) return { type: 'unary', op: '-', right: parseUnary() };
    if (match('+')) return { type: 'unary', op: '+', right: parseUnary() };
    return parsePower();
  }
  function parsePower() {
    const left = parsePrimary();


    if (match('**')) return { type: 'binary', op: '**', left, right: parseUnary() };
    return left;
  }
  function binary(next, operators) {
    return () => {
      let left = next();
      while (operators.includes(peek().value)) { const op = take().value; const right = next(); left = { type: 'binary', op, left, right }; }
      return left;
    };
  }
  const parseMul = binary(parseUnary, ['*', '/', '%']);
  const parseAdd = binary(parseMul, ['+', '-']);
  const parseCompare = binary(parseAdd, ['<', '<=', '>', '>=']);
  const parseEquality = binary(parseCompare, ['==', '===', '!=', '!==']);
  const parseAnd = binary(parseEquality, ['&&']);
  const parseOr = binary(parseAnd, ['||']);
  const ast = parseOr();
  if (peek().type !== 'eof') throw new Error(`Unexpected content "${peek().value}" at position ${peek().pos + 1}.`);
  return ast;
}

function listExpressionReferences(input) {
  const ast = parseExpression(input);
  const refs = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'call' && node.name === 'tag') refs.push(node.args[0].value);
    if (node.left) visit(node.left);
    if (node.right) visit(node.right);
    for (const arg of node.args || []) visit(arg);
  }
  visit(ast);
  return [...new Set(refs)];
}

function evaluateExpression(input, getTagValue) {
  const ast = parseExpression(input);
  const numeric = (value, op) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Operator ${op} requires finite numeric values.`);
    return value;
  };
  function evalNode(node) {
    if (node.type === 'literal') return node.value;
    if (node.type === 'unary') {
      const value = evalNode(node.right);
      if (node.op === '!') return !value;
      numeric(value, node.op);
      return node.op === '-' ? -value : value;
    }
    if (node.type === 'binary') {
      const left = evalNode(node.left);
      if (node.op === '&&') return left ? evalNode(node.right) : left;
      if (node.op === '||') return left ? left : evalNode(node.right);
      const right = evalNode(node.right);
      switch (node.op) {
        case '+': if (typeof left === 'string' || typeof right === 'string') return String(left) + String(right); return numeric(left, '+') + numeric(right, '+');
        case '-': return numeric(left, '-') - numeric(right, '-');
        case '*': return numeric(left, '*') * numeric(right, '*');
        case '/': { const divisor = numeric(right, '/'); if (divisor === 0) throw new Error('Division by zero in expression.'); return numeric(left, '/') / divisor; }
        case '%': { const divisor = numeric(right, '%'); if (divisor === 0) throw new Error('Modulo by zero in expression.'); return numeric(left, '%') % divisor; }
        case '**': return numeric(left, '**') ** numeric(right, '**');
        case '<': return left < right; case '<=': return left <= right; case '>': return left > right; case '>=': return left >= right;
        case '==': case '===': return left === right;
        case '!=': case '!==': return left !== right;
        default: throw new Error(`Operator not allowed: ${node.op}`);
      }
    }
    if (node.type === 'call') {
      if (node.name === 'tag') {
        const result = getTagValue(node.args[0].value);
        if (!result || result.quality !== 'GOOD' || result.value === undefined || result.value === null) throw new Error(`Referenced tag "${node.args[0].value}" has no GOOD value available.`);
        return result.value;
      }
      if (node.name === 'if') {
        if (node.args.length !== 3) throw new Error('if(condition, true_value, false_value) requires 3 arguments.');
        return evalNode(node.args[0]) ? evalNode(node.args[1]) : evalNode(node.args[2]);
      }
      if (node.name === 'coalesce') {
        for (const arg of node.args) { try { const value = evalNode(arg); if (value !== null && value !== undefined) return value; } catch {} }
        return null;
      }
      const args = node.args.map(evalNode);
      const nums = () => args.map(value => numeric(value, node.name));
      switch (node.name) {
        case 'min': if (!args.length) throw new Error('min() requires at least one argument.'); return Math.min(...nums());
        case 'max': if (!args.length) throw new Error('max() requires at least one argument.'); return Math.max(...nums());
        case 'sum': if (!args.length) throw new Error('sum() requires at least one argument.'); return nums().reduce((sum, value) => sum + value, 0);
        case 'avg': case 'mean': if (!args.length) throw new Error(`${node.name}() requires at least one argument.`); return nums().reduce((sum, value) => sum + value, 0) / args.length;
        case 'abs': if (args.length !== 1) throw new Error('abs() requires one argument.'); return Math.abs(nums()[0]);
        case 'round': if (args.length < 1 || args.length > 2) throw new Error('round() admite uno o dos argumentos.'); { const n = nums(); const scale = n[1] === undefined ? 1 : 10 ** n[1]; return Math.round(n[0] * scale) / scale; }
        case 'floor': if (args.length !== 1) throw new Error('floor() requires one argument.'); return Math.floor(nums()[0]);
        case 'ceil': if (args.length !== 1) throw new Error('ceil() requires one argument.'); return Math.ceil(nums()[0]);
        case 'sqrt': if (args.length !== 1 || nums()[0] < 0) throw new Error('sqrt() requires a non-negative number.'); return Math.sqrt(nums()[0]);
        case 'pow': if (args.length !== 2) throw new Error('pow() requires two arguments.'); return Math.pow(...nums());
        case 'clamp': case 'limit': if (args.length !== 3) throw new Error(`${node.name}(value, minimum, maximum) requires three arguments.`); { const n = nums(); if (n[1] > n[2]) throw new Error('Minimum cannot exceed maximum.'); return Math.min(n[2], Math.max(n[1], n[0])); }
        case 'scale': if (args.length !== 5) throw new Error('scale(value, inputMin, inputMax, outputMin, outputMax) requires five arguments.'); { const n = nums(); if (n[1] === n[2]) throw new Error('scale() does not accept equal input bounds.'); return (n[0] - n[1]) / (n[2] - n[1]) * (n[4] - n[3]) + n[3]; }
        case 'bit': if (args.length !== 2) throw new Error('bit(value, index) requires two arguments.'); { const n = nums(); if (!Number.isSafeInteger(n[0]) || !Number.isInteger(n[1]) || n[1] < 0 || n[1] > 52) throw new Error('bit() requires a safe integer and an index from 0 to 52.'); return ((BigInt(n[0]) >> BigInt(n[1])) & 1n) === 1n; }
        case 'concat': return args.map(String).join('');
        default: throw new Error(`Function not allowed: ${node.name}`);
      }
    }
    throw new Error('Invalid expression AST.');
  }
  const result = evalNode(ast);
  if (typeof result === 'number' && !Number.isFinite(result)) throw new Error('The expression produced a non-finite result.');
  if (typeof result === 'string' && result.length > 4000) throw new Error('The expression produced text that is too long.');
  return result;
}

module.exports = { parseExpression, listExpressionReferences, evaluateExpression };
