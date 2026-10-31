/**
 * 极简 DOM 桩：只实现 edit-restart client.js 扫描/装饰链路用到的 API。
 * 放在独立模块里是为了让 harness 与调试脚本共用同一份，避免两处漂移。
 */
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this._parent = null
    this._children = []
    this.attributes = new Map()
    this.classList = {
      _set: new Set(),
      add: (name) => { this.classList._set.add(name) },
      contains: (name) => this.classList._set.has(name),
    }
    this.title = ''
    this.className = ''
    this.id = ''
    // 浏览器元素的 dataset 是实时视图：这里用 Proxy 让 dataset.xxx 等价于 data-xxx 属性。
    this.dataset = new Proxy({}, {
      set: (_, key, value) => { this.setAttribute('data-' + key, value); return true },
      get: (_, key) => this.getAttribute('data-' + key) ?? undefined,
      has: (_, key) => this.hasAttribute('data-' + key),
      deleteProperty: (_, key) => { this.removeAttribute('data-' + key); return true },
    })
  }
  get children() { return this._children }
  set children(value) { this._children = value }
  get parentElement() { return this._parent }
  set parentElement(value) { this._parent = value }
  get isConnected() {
    let node = this
    while (node._parent) node = node._parent
    return node === global.document.body
  }
  appendChild(child) {
    if (child._parent) child._parent._children = child._parent._children.filter((n) => n !== child)
    child._parent = this
    this._children.push(child)
    mutations.push({ target: this, added: [child], removed: [] })
    return child
  }
  remove() {
    if (this._parent) {
      this._parent._children = this._parent._children.filter((n) => n !== this)
      mutations.push({ target: this._parent, added: [], removed: [this] })
    }
    this._parent = null
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') this.className = String(value)
    if (name === 'id') this.id = String(value)
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  querySelectorAll(selector) {
    const out = []
    for (const child of this._children) {
      if (match(child, selector)) out.push(child)
      out.push(...child.querySelectorAll(selector))
    }
    return out
  }
  querySelector(selector) {
    const list = this.querySelectorAll(selector)
    return list.length > 0 ? list[0] : null
  }
  closest(selector) {
    let node = this
    while (node) {
      if (match(node, selector)) return node
      node = node._parent
    }
    return null
  }
  focus() {}
  setSelectionRange() {}
}

/** 只支持本插件用到的少数选择器。 */
function match(node, selector) {
  if (!node || node.nodeType !== 1) return false
  const lower = String(node.tagName || '').toLowerCase()
  if (/^[a-z]+$/.test(selector)) return lower === selector
  const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
  if (attr) {
    const [, name, value] = attr
    if (!node.hasAttribute(name)) return false
    return value === undefined || node.getAttribute(name) === value
  }
  const tagAttr = /^([a-z]+)\[([a-z-]+)\]$/.exec(selector)
  if (tagAttr) return lower === tagAttr[1] && node.hasAttribute(tagAttr[2])
  if (selector.includes('.')) {
    const [tagPart, ...classes] = selector.split('.')
    if (tagPart !== '' && lower !== tagPart) return false
    return classes.every((name) => node.classList.contains(name))
  }
  return false
}

/**
 * 造一条用户消息的真实结构：flow 行 > 气泡列(_userRow) > 气泡本体(_userStack) + 操作行(_actions)。
 * @returns {{row, column, bubble, actionsRow, copyButton}}
 */
function makeUserRow(flowKey, parent) {
  const row = new Node('div')
  row.setAttribute('data-chat-flow-key', flowKey)
  row.setAttribute('data-chat-flow-kind', 'user')
  // 气泡列：官方 _userRow（竖排 flex、右对齐）
  const column = new Node('div')
  column.setAttribute('class', 'AbCdEf_userRow')
  // 气泡本体：官方 _userStack
  const bubble = new Node('div')
  bubble.setAttribute('class', 'AbCdEf_userStack')
  const bubbleText = new Node('div')
  bubbleText.appendChild(new Node('span'))
  bubble.appendChild(bubbleText)
  // 操作行：官方 _actions（复制按钮；带 data-clock="start"）
  const actionsRow = new Node('div')
  actionsRow.setAttribute('class', 'AbCdEf_actions')
  actionsRow.setAttribute('data-clock', 'start')
  const copyButton = new Node('button')
  copyButton.appendChild(new Node('svg'))
  actionsRow.appendChild(copyButton)
  column.appendChild(bubble)
  column.appendChild(actionsRow)
  row.appendChild(column)
  parent.appendChild(row)
  return { row, column, bubble, actionsRow, copyButton }
}

/** 造一个会话内容区：两条用户消息中间夹一条助手回复。 */
function buildConversation(sessionId) {
  const content = new Node('div')
  content.setAttribute('data-conversation-content', '')
  content.setAttribute('data-conversation-session', sessionId)
  const flow = new Node('div')
  content.appendChild(flow)
  const first = makeUserRow('flow-1', flow)
  const assistantRow = new Node('div')
  assistantRow.setAttribute('data-chat-flow-key', 'assistant-1')
  assistantRow.appendChild(new Node('div'))
  const assistantActions = new Node('div')
  assistantActions.setAttribute('data-clock', 'end')
  const assistantCopy = new Node('button')
  assistantCopy.appendChild(new Node('svg'))
  assistantActions.appendChild(assistantCopy)
  assistantRow.appendChild(assistantActions)
  flow.appendChild(assistantRow)
  const second = makeUserRow('flow-2', flow)
  return { content, first, second }
}

/** 记录每一次 childList 变更（供 MutationObserver 桩使用）。 */
const mutations = []

function installDocument() {
  const body = new Node('body')
  const head = new Node('head')
  const documentStub = {
    body,
    head,
    createElement: (tag) => new Node(tag),
    createElementNS: (ns, tag) => new Node(tag),
    // 浏览器语义：文档顺序里的第一个匹配（新节点追加在末尾，旧节点被移除后才轮到它）。
    querySelector: (selector) => {
      const stack = [...body.children].reverse()
      while (stack.length > 0) {
        const node = stack.pop()
        if (match(node, selector)) return node
        stack.push(...[...node.children].reverse())
      }
      return match(body, selector) ? body : null
    },
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    getElementById: (id) => body.querySelectorAll('[id]').find((n) => n.getAttribute('id') === id) || null,
    addEventListener() {},
    removeEventListener() {},
  }
  global.document = documentStub
  return { body, head, documentStub }
}

module.exports = { Node, match, makeUserRow, buildConversation, installDocument, mutations }
