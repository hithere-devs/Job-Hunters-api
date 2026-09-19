/* Apply Pilot page script. MAIN world. Snapshot + primitive actions only. */
(() => {
  if (window.__APPLY_PILOT__?.version >= 16) return

  const ENTRY_SEL = '.ashby-application-form-field-entry, [data-field-entry-id], fieldset[class*="fieldEntry"], .field-wrapper, .phone-input__country, .application-question, li.application-question, .opening-form__field, [data-qa="field"], .form-field, .application-field'
  const OPTION_SEL = [
    '[role="option"]',
    '.ashby-application-form-input-autocomplete-popup-result',
    '[class*="autocomplete-popup"] [class*="result"]',
    '[class*="Autocomplete"] [class*="option" i]',
    'ul[role="listbox"] li',
    '[id*="downshift-"][role="option"]',
    '[id*="react-select"] [class*="option"]',
    '.select__option',
    '[class*="select__option"]',
    'li.select2-result, .select2-result-label, [class*="select-option"], [class*="SelectOption"]',
    '[data-radix-collection-item]',
    '.iti__country',
    '.iti__country-name',
  ].join(', ')
  const PLACEHOLDER_OPTION = /^(?:select|choose|please\s+select|start typing|type to search|type your response|search|loading|no results|nothing found|n\/a|-|–|—)\b/i
  const PLACEHOLDER_PROMPT = /^(?:type your response|start typing|please select|select\.\.\.|choose an option)\b/i
  const ATTR = 'data-apply-id'

  function fold(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  }
  function cleanLabel(label) {
    return String(label ?? '')
      .replace(/start typing\.\.\.?/gi, ' ')
      .replace(/type your response/gi, ' ')
      .replace(/[\u2731\u066D\uFF0A*†‡]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\*$/, '')
      .trim()
  }
  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
  function visible(node) {
    if (!(node instanceof Element)) return false
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  function stamp(node) {
    if (node instanceof Element) {
      const existing = node.getAttribute(ATTR)
      if (existing) return existing
    }
    let n = 1
    while (document.querySelector(`[${ATTR}="e${n}"]`)) n += 1
    const id = `e${n}`
    if (node instanceof Element) node.setAttribute(ATTR, id)
    return id
  }
  function byId(id) {
    if (!id) return null
    return document.querySelector(`[${ATTR}="${CSS.escape(id)}"]`)
  }
  function wordish(character) {
    return character !== undefined && /[a-z0-9]/.test(character)
  }
  function includesWord(haystack, needle) {
    if (!haystack || !needle) return false
    for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
      if (!wordish(haystack[index - 1]) && !wordish(haystack[index + needle.length])) return true
    }
    return false
  }
  function scoreOption(query, option) {
    const wanted = fold(query)
    const choice = fold(option)
    if (!wanted || !choice || PLACEHOLDER_OPTION.test(choice)) return 0
    if (choice === wanted) return 100
    if ((wanted === 'male' && choice === 'man') || (wanted === 'man' && choice === 'male')) return 90
    if ((wanted === 'female' && choice === 'woman') || (wanted === 'woman' && choice === 'female')) return 90
    if (/^(indian|asian indian|south asian|indian asian)$/.test(wanted) && /american indian|alaska native|native american/.test(choice)) return 0
    if (/^(indian|asian indian|south asian|indian asian|asian)$/.test(wanted) && /east asian|southeast asian|west asian|central asian/.test(choice)) return 0
    if (/^(indian|asian indian|south asian|indian asian)$/.test(wanted) && choice === 'south asian') return 95
    if (/^(indian|asian indian|south asian|indian asian)$/.test(wanted) && (choice === 'asian' || choice.startsWith('asian '))) return 82
    if (/not a (?:protected )?veteran|i am not a/.test(wanted) && /unspecified/.test(choice)) return 0
    if (/not a (?:protected )?veteran|i am not a|no military service/.test(wanted) && /vietnam|korean war|armed forces|recently separated/.test(choice)) return 0
    if (/not a (?:protected )?veteran|i am not a|no military service/.test(wanted) && choice === 'no military service') return 95
    if (/not a (?:protected )?veteran|i am not a/.test(wanted) && /^other /.test(choice)) return 0
    if (/not a (?:protected )?veteran|i am not a/.test(wanted) && /protected veteran/.test(choice) && !/not a|i am not|do not/.test(choice)) return 0
    if (choice.startsWith(wanted) && !wordish(choice[wanted.length])) return 85
    if (wanted.startsWith(choice) && !wordish(wanted[choice.length])) return 85
    if (includesWord(choice, wanted) || includesWord(wanted, choice)) return 70
    const tokens = wanted.split(/[,\s/]+/).filter((token) => token.length > 1)
    if (!tokens.length) return 0
    let hits = 0
    for (const token of tokens) {
      if (choice === token || includesWord(choice, token)) hits += 1
    }
    if (!hits) return 0
    return hits === tokens.length ? 60 : 35 + hits * 8
  }
  function pickOption(options, value) {
    let best = null
    for (const option of options) {
      if (PLACEHOLDER_OPTION.test(fold(option))) continue
      const score = scoreOption(value, option)
      if (!best || score > best.score) best = { option, score }
    }
    return best && best.score >= 35 ? best.option : null
  }
  function valueMatches(have, wanted) {
    const a = fold(have)
    const b = fold(wanted)
    if (!a || !b) return false
    if (a === b || a.includes(b) || b.includes(a)) return true
    const x = a.replace(/[^a-z0-9]/g, '')
    const y = b.replace(/[^a-z0-9]/g, '')
    return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)))
  }
  function isPlaceholderChoice(label) {
    const text = fold(label)
    return !text || PLACEHOLDER_OPTION.test(text)
  }
  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc?.set) desc.set.call(element, value)
    else element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function clickNode(node) {
    if (!(node instanceof HTMLElement)) return false
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, buttons: 1, button: 0 }
    try {
      node.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }))
    } catch {
      node.dispatchEvent(new MouseEvent('pointerdown', opts))
    }
    node.dispatchEvent(new MouseEvent('mousedown', opts))
    try {
      node.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }))
    } catch {
      node.dispatchEvent(new MouseEvent('pointerup', opts))
    }
    node.dispatchEvent(new MouseEvent('mouseup', opts))
    node.click()
    return true
  }
  function isReactSelect(control) {
    return Boolean(control?.closest?.('.select__control, .select-shell, .select__container, [class*="select__control"]'))
  }
  function yesNoWanted(value) {
    const trimmed = String(value ?? '').trim()
    if (/^(?:true|yes)\b/i.test(trimmed) || /^y$/i.test(trimmed)) return 'Yes'
    if (/^(?:false|no)\b/i.test(trimmed) || /^n$/i.test(trimmed)) return 'No'
    return null
  }
  let activeMenu = 'any'
  function isShownOption(node) {
    if (!(node instanceof HTMLElement) || !visible(node)) return false
    const phoneOption = Boolean(node.closest('.iti__country-list, .iti__country'))
    if (activeMenu === 'select' && phoneOption) return false
    if (activeMenu === 'phone' && !phoneOption) return false
    return true
  }
  function listedOptions() {
    const openMenu = Array.from(document.querySelectorAll('.select__menu, [class*="menu-list"], [class*="MenuList"]'))
      .find((node) => node instanceof HTMLElement && visible(node) && node.getBoundingClientRect().height > 20)
    const root = openMenu instanceof Element ? openMenu : document
    const texts = []
    for (const node of Array.from(root.querySelectorAll(OPTION_SEL))) {
      if (!isShownOption(node)) continue
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()
      if (text && !isPlaceholderChoice(text) && !texts.includes(text)) texts.push(text)
    }
    return texts
  }
  function clickListedOption(text) {
    const wanted = fold(text)
    const openMenu = Array.from(document.querySelectorAll('.select__menu, [class*="menu-list"], [class*="MenuList"]'))
      .find((node) => node instanceof HTMLElement && visible(node) && node.getBoundingClientRect().height > 20)
    const root = openMenu instanceof Element ? openMenu : document
    const nodes = Array.from(root.querySelectorAll(OPTION_SEL)).filter((node) => isShownOption(node))
    const exact = nodes.find((node) => fold((node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()) === wanted)
    if (exact instanceof HTMLElement) return clickNode(exact)
    let best = null
    let bestScore = 0
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue
      const label = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()
      const score = scoreOption(text, label)
      if (score > bestScore) {
        best = node
        bestScore = score
      }
    }
    if (best && bestScore >= 35) return clickNode(best)
    return false
  }
  function flyoutButton(control) {
    const shell = control.closest('.select__control, [class*="-control"], .select, .select-shell, .phone-input__country, ._inputContainer_d7ago_28')
    const root = shell instanceof HTMLElement ? shell : control.parentElement
    const button = root?.querySelector('button[aria-label*="flyout" i], button[aria-label*="Toggle" i], .select__dropdown-indicator, [class*="indicatorContainer"] button, button._toggleButton_d7ago_32, button')
    return button instanceof HTMLElement ? button : null
  }
  async function openFlyout(control) {
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(40)
    const flag = control.closest('.iti')?.querySelector('.iti__selected-flag, .iti__flag-container')
    if (flag instanceof HTMLElement) {
      clickNode(flag)
      await wait(160)
      if (listedOptions().length) return
    }
    const shell = control.closest('.select__control, [class*="-control"], .select, .select-shell, .phone-input__country')
    clickNode(shell instanceof HTMLElement ? shell : control)
    await wait(200)
    if (listedOptions().length) return
    if (control instanceof HTMLElement) {
      control.focus()
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      await wait(220)
      if (listedOptions().length) return
    }
    const expanded = control.getAttribute('aria-expanded') === 'true'
      || Boolean((shell instanceof HTMLElement ? shell : control.parentElement)?.querySelector('[aria-expanded="true"]'))
    const toggle = flyoutButton(control)
    if (toggle && !expanded) clickNode(toggle)
    await wait(250)
  }
  async function typeQuery(input, query) {
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return
    input.focus()
    clickNode(input)
    setNativeValue(input, '')
    await wait(40)
    let built = ''
    for (const char of String(query)) {
      built += char
      setNativeValue(input, built)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }))
      await wait(25)
    }
  }
  function selectedChoiceText(entry, control) {
    const roots = [
      control?.closest('.select__value-container, [class*="value-container"]'),
      control?.closest('.select__control'),
    ].filter(Boolean)
    const chips = []
    for (const root of roots) {
      for (const node of Array.from(root.querySelectorAll('.select__single-value, .select__multi-value__label, [class*="singleValue"], [class*="single-value"]:not([class*="remove"]):not([class*="container"]), [class*="multi-value__label"]'))) {
        if (!(node instanceof HTMLElement) || !visible(node)) continue
        if (node.closest('label, legend, .select__label, .question-description, .select__placeholder')) continue
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
        if (text && !isPlaceholderChoice(text) && !/^remove /i.test(text) && !chips.includes(text)) chips.push(text)
      }
    }
    return chips.join(', ')
  }
  function greenhouseHiddenValue(node, control) {
    const wrap = control?.closest?.('.field-wrapper')
      || control?.closest?.('.select')
      || (node instanceof Element ? node : null)
    if (!(wrap instanceof Element)) return null
    const hidden = wrap.querySelector('input[required][aria-hidden="true"], input[tabindex="-1"][required]')
    if (!(hidden instanceof HTMLInputElement)) return null
    return hidden.value.trim()
  }
  function controlFor(node) {
    if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement) return node
    if (!(node instanceof Element)) return null
    const tel = node.querySelector('input[type="tel"]')
    if (tel) return tel
    const combo = node.querySelector('[role="combobox"], input.ashby-application-form-input-autocomplete, input[aria-autocomplete]')
    if (combo) return combo
    const select = node.querySelector('select')
    if (select) return select
    const area = node.querySelector('textarea')
    if (area) return area
    const editable = node.querySelector('[contenteditable="true"]')
    if (editable) return editable
    const text = node.querySelector('input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="password"])')
    if (text) return text
    const file = node.querySelector('input[type="file"]')
    if (file) return file
    return node
  }
  function committedFrom(node) {
    if (!(node instanceof Element)) return ''
    const yesno = node.matches('.ashby-application-form-input-yesno') ? node : node.querySelector('.ashby-application-form-input-yesno')
    if (yesno) {
      const pressed = Array.from(yesno.querySelectorAll('button')).find((button) => button.getAttribute('aria-pressed') === 'true')
      return (pressed?.textContent || '').trim()
    }
    const radios = Array.from(node.querySelectorAll('input[type="radio"]'))
    if (radios.length) {
      const checked = radios.find((radio) => radio instanceof HTMLInputElement && radio.checked)
      if (!(checked instanceof HTMLInputElement)) return ''
      const id = checked.getAttribute('id')
      const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() || '' : ''
      const wrap = checked.closest('label')?.textContent?.trim() || ''
      return (forLabel || wrap || checked.value || '').replace(/\s+/g, ' ').trim()
    }
    const ariaRadio = Array.from(node.querySelectorAll('[role="radio"], [aria-pressed]')).find((item) => item.getAttribute('aria-checked') === 'true' || item.getAttribute('aria-pressed') === 'true')
    if (ariaRadio) return (ariaRadio.textContent || '').replace(/\s+/g, ' ').trim()
    const control = controlFor(node)
    if (control instanceof HTMLSelectElement) {
      const texts = Array.from(control.selectedOptions)
        .map((option) => (option.label || option.textContent || option.value || '').trim())
        .filter((text) => text && !isPlaceholderChoice(text))
      return texts.join(', ')
    }
    if (control instanceof HTMLInputElement) {
      if (control.type === 'checkbox') return control.checked ? 'true' : ''
      if (control.type === 'file') return control.files && control.files.length ? control.files[0].name : ''
      const combo = control.getAttribute('role') === 'combobox' || Boolean(control.getAttribute('aria-autocomplete'))
      const value = control.value.trim()
      if (!combo && value && !isPlaceholderChoice(value)) return value
      const shown = selectedChoiceText(node, control)
      const hidden = greenhouseHiddenValue(node, control)
      if (combo && isReactSelect(control) && hidden !== null) return hidden ? (shown || hidden) : ''
      if (shown) return shown
      if (combo && isReactSelect(control)) return ''
      if (combo && control.getAttribute('aria-invalid') === 'true') return ''
      if (combo && value.length <= 2) return shown || ''
      if (value && !isPlaceholderChoice(value) && !/^start typing/i.test(value)) return value
      return ''
    }
    if (control instanceof HTMLTextAreaElement) return control.value.trim()
    if (control instanceof HTMLElement && control.getAttribute('contenteditable') === 'true') return (control.innerText || '').trim()
    if (node instanceof HTMLButtonElement || node.getAttribute('role') === 'button') return (node.innerText || '').trim()
    return ''
  }
  function requiredOf(node, label, control) {
    if (/(?:[✱*]|\(required\))\s*$/i.test(label)) return true
    const scope = node instanceof Element ? (node.closest(ENTRY_SEL) || node) : node
    if (scope instanceof Element && scope.querySelector('[required], [aria-required="true"], [class*="_required_"]')) return true
    if (control && (control.required || control.getAttribute?.('aria-required') === 'true')) return true
    return false
  }
  function nationalPhoneNumber(value) {
    const raw = String(value || '').trim()
    const digits = raw.replace(/[^\d]/g, '')
    if (!digits) return raw
    if (!raw.startsWith('+') && !/^00/.test(raw) && !/^\d{1,3}\s/.test(raw)) return digits.length >= 8 ? digits : raw
    const codes = ['971', '353', '91', '44', '61', '49', '65', '31', '33', '1']
    for (const code of codes) {
      if (digits.startsWith(code) && digits.length > code.length + 5) return digits.slice(code.length).replace(/^0+/, '')
    }
    return digits
  }
  function roleOf(node, control) {
    if (node instanceof Element && (node.matches('.ashby-application-form-input-yesno') || node.querySelector('.ashby-application-form-input-yesno'))) return 'yesno'
    if (control instanceof HTMLSelectElement) return 'select'
    if (control instanceof HTMLTextAreaElement) return 'textarea'
    if (control instanceof HTMLInputElement) {
      if (control.type === 'file') return 'file'
      if (control.type === 'checkbox') return 'checkbox'
      if (control.type === 'radio') return 'radio'
      if (control.type === 'email') return 'email'
      if (control.type === 'tel') return 'tel'
      if (control.type === 'url') return 'url'
      if (control.getAttribute('role') === 'combobox' || control.getAttribute('aria-autocomplete') || /autocomplete/i.test(control.className)) return 'combobox'
      return control.type || 'textbox'
    }
    if (node instanceof HTMLButtonElement || node.getAttribute?.('role') === 'button') return 'button'
    if (node instanceof HTMLAnchorElement) return 'link'
    if (control instanceof HTMLElement && control.getAttribute('contenteditable') === 'true') return 'textarea'
    return 'textbox'
  }
  function optionsOf(node, control, role) {
    if (role === 'yesno') return ['Yes', 'No']
    if (control instanceof HTMLSelectElement) {
      return Array.from(control.options).map((option) => (option.label || option.textContent || '').trim()).filter((text) => text && !isPlaceholderChoice(text))
    }
    if (role === 'radio' || (role === 'checkbox' && node instanceof Element)) {
      const inputs = Array.from(node.querySelectorAll(role === 'radio' ? 'input[type="radio"]' : 'input[type="checkbox"]'))
      const labels = []
      for (const input of inputs) {
        const id = input.getAttribute('id')
        const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() || '' : ''
        const wrap = input.closest('label')?.textContent?.trim() || ''
        const text = (forLabel || wrap || input.value || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        if (text) labels.push(text)
      }
      return labels.length > 1 ? labels : []
    }
    return []
  }
  function questionLabel(entry) {
    if (!(entry instanceof Element)) return ''
    const titled = entry.querySelector('.application-label, legend, .ashby-application-form-question-title, [class*="question-title"], [class*="fieldLabel"], [class*="FieldLabel"]')
    if (titled && !titled.querySelector('input, select, textarea')) {
      const text = cleanLabel(titled.textContent || '')
      if (text && !/^(yes|no)$/i.test(text) && text.length > 2) return text.slice(0, 200)
    }
    const standalone = Array.from(entry.querySelectorAll('label, legend')).find((node) => {
      if (node.querySelector('input, select, textarea')) return false
      const text = cleanLabel(node.textContent || '')
      return text.length > 1 && !/^(yes|no)$/i.test(text)
    })
    if (standalone) return cleanLabel(standalone.textContent || '').slice(0, 200)
    const heading = Array.from(entry.querySelectorAll('p, h3, h4, div, span')).find((node) => {
      if (node.querySelector('input, select, textarea')) return false
      const text = cleanLabel(node.textContent || '')
      return text.length > 12 && !/^(yes|no)$/i.test(text)
    })
    return heading ? cleanLabel(heading.textContent || '').slice(0, 200) : ''
  }
  function labelFor(node, control) {
    if (node instanceof Element) {
      const titled = node.querySelector('label, legend, .ashby-application-form-question-title, [class*="question-title"], [class*="fieldLabel"], [class*="FieldLabel"]')
      if (titled && !titled.querySelector('input, select, textarea, button')) {
        const text = cleanLabel(titled.textContent || '')
        if (text && !PLACEHOLDER_PROMPT.test(text) && text.length > 1) return text.slice(0, 200)
      }
    }
    const id = control?.getAttribute?.('id')
    if (id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`)
      if (explicit?.textContent?.trim()) return cleanLabel(explicit.textContent).slice(0, 200)
    }
    if (control?.getAttribute?.('aria-label')) return cleanLabel(control.getAttribute('aria-label')).slice(0, 200)
    const wrapping = control?.closest?.('label') || (node instanceof Element ? node.closest('label') : null)
    if (wrapping?.textContent?.trim()) return cleanLabel(wrapping.textContent).slice(0, 200)
    if (node instanceof HTMLElement && (node.matches('button, a, [role="button"]') || node.tagName === 'BUTTON')) {
      return cleanLabel(node.innerText || node.getAttribute('aria-label') || node.value || '').slice(0, 120)
    }
    return cleanLabel(control?.getAttribute?.('placeholder') || control?.getAttribute?.('name') || '').slice(0, 200)
  }
  function emitElement(found, node, extra) {
    const control = extra.control ?? controlFor(node)
    const role = extra.role ?? roleOf(node, control)
    let label = extra.label || labelFor(node, control)
    if (/^(yes|no)$/i.test(String(label).trim()) && node instanceof Element) {
      const host = node.closest('li.application-question, fieldset, .application-question, .field-wrapper') || node
      const better = questionLabel(host)
      if (better) label = better
    }
    if (!label) return null
    const id = stamp(node instanceof Element ? node : control)
    const value = committedFrom(node)
    const options = extra.options ?? optionsOf(node, control, role)
    const required = extra.required ?? requiredOf(node, extra.rawLabel || label, control)
    const filled = role === 'button' || role === 'link' ? false : Boolean(value) && (role !== 'checkbox' || value === 'true' || value === 'Yes')
    const row = {
      id,
      role,
      label: cleanLabel(label).slice(0, 200),
      required,
      value: value.slice(0, 240),
      filled: role === 'checkbox' && options.length <= 1 ? value === 'true' : Boolean(value) && !isPlaceholderChoice(value),
      options: options.slice(0, 30),
      enabled: !(control?.disabled),
      name: control?.getAttribute?.('name') || undefined,
    }
    if (role === 'button' || role === 'link') row.filled = false
    found.push(row)
    return row
  }

  function snapshot() {
    const found = []
    const covered = []
    const scope = document
    const entries = Array.from(scope.querySelectorAll(ENTRY_SEL)).filter((entry) => {
      if (!visible(entry) && !entry.querySelector('input[type="radio"], input[type="checkbox"]')) return false
      return !entry.querySelector(ENTRY_SEL)
    })
    for (const entry of entries) {
      const yesno = entry.querySelector('.ashby-application-form-input-yesno')
      const combo = entry.querySelector('[role="combobox"], input.ashby-application-form-input-autocomplete')
      const file = entry.querySelector('input[type="file"]')
      const select = entry.querySelector('select')
      const textarea = entry.querySelector('textarea')
      const radios = Array.from(entry.querySelectorAll('input[type="radio"]'))
      const checks = Array.from(entry.querySelectorAll('input[type="checkbox"]')).filter((box) => !box.closest('.ashby-application-form-input-yesno'))
      const rawLabel = questionLabel(entry) || (entry.querySelector('legend, .ashby-application-form-question-title, label')?.textContent || '').trim()
      const label = cleanLabel(rawLabel)
      if (yesno) {
        emitElement(found, yesno.closest(ENTRY_SEL) || yesno, { role: 'yesno', label: label || 'Yes or no', rawLabel, options: ['Yes', 'No'], control: yesno })
        covered.push(...Array.from(entry.querySelectorAll('input, select, textarea, button')))
        continue
      }
      if (combo) {
        const phoneCountry = Boolean(combo.closest('.iti, .phone-input__country, .iti__flag-container') || entry.matches?.('.phone-input__country') || (entry.querySelector('input[type="tel"]') && /^country$/i.test(label)))
        emitElement(found, entry, { role: 'combobox', label: phoneCountry ? 'Phone country code' : label, rawLabel, control: combo })
        covered.push(...Array.from(entry.querySelectorAll('input, select, textarea')))
        continue
      }
      if (file) {
        emitElement(found, file, { role: 'file', label, rawLabel, control: file })
        covered.push(file)
        continue
      }
      if (select instanceof HTMLSelectElement) {
        emitElement(found, select, { role: 'select', label, rawLabel, control: select })
        covered.push(select)
        continue
      }
      if (radios.length) {
        emitElement(found, entry, { role: 'radio', label, rawLabel, control: radios[0] })
        covered.push(...radios)
        continue
      }
      if (textarea) {
        emitElement(found, textarea, { role: 'textarea', label, rawLabel, control: textarea })
        covered.push(textarea)
        continue
      }
      if (checks.length > 1) {
        emitElement(found, entry, { role: 'checkbox', label, rawLabel, control: checks[0] })
        covered.push(...checks)
        continue
      }
      const text = entry.querySelector('input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="password"])')
      if (text) {
        emitElement(found, text, { label, rawLabel, control: text })
        covered.push(text)
        continue
      }
      if (checks.length === 1) {
        emitElement(found, checks[0], { role: 'checkbox', label, rawLabel, control: checks[0] })
        covered.push(checks[0])
      }
    }

    const controls = Array.from(scope.querySelectorAll('input, select, textarea, [contenteditable="true"]'))
    for (const element of controls) {
      if (covered.includes(element)) continue
      if (!(element instanceof HTMLElement)) continue
      const type = element.type || element.tagName.toLowerCase()
      if (['hidden', 'password', 'submit', 'button', 'image', 'reset'].includes(type)) continue
      if (element.disabled || /^(current-password|new-password|one-time-code)$/.test(element.getAttribute('autocomplete') || '')) continue
      if (element.closest('.ashby-application-form-input-yesno')) continue
      if (!['radio', 'checkbox'].includes(type) && !visible(element)) continue
      if (type === 'radio' && element.name) {
        if (found.some((row) => row.name === element.name && row.role === 'radio')) continue
        const group = element.closest('fieldset, [role="radiogroup"], .application-question, [class*="fieldEntry"]') || element
        emitElement(found, group, { role: 'radio', control: element })
        continue
      }
      if (type === 'checkbox' && element.name) {
        const siblings = Array.from(scope.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(element.name)}"]`))
        if (siblings.length > 1) {
          if (found.some((row) => row.name === element.name && row.role === 'checkbox')) continue
          emitElement(found, element.closest('fieldset, .application-question') || element, { role: 'checkbox', control: element })
          continue
        }
      }
      emitElement(found, element, { control: element })
    }

    for (const hidden of Array.from(scope.querySelectorAll('input[required][aria-hidden="true"], input[tabindex="-1"][required]'))) {
      if (!(hidden instanceof HTMLInputElement) || hidden.value.trim()) continue
      const wrap = hidden.closest('.field-wrapper, .select, .application-question')
      if (!(wrap instanceof Element)) continue
      const label = cleanLabel(wrap.querySelector('label, legend')?.textContent || '')
      if (!label) continue
      const existing = found.find((row) => row.label === label)
      if (existing) {
        existing.filled = false
        existing.value = ''
        existing.required = true
        if (!existing.role || existing.role === 'textbox') existing.role = 'combobox'
      } else {
        const combo = wrap.querySelector('[role="combobox"], input.select__input')
        emitElement(found, wrap, { role: 'combobox', label, rawLabel: label, required: true, control: combo || hidden })
        const row = found[found.length - 1]
        if (row) {
          row.filled = false
          row.value = ''
          row.required = true
        }
      }
    }

    const clickables = Array.from(scope.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]'))
      .filter((node) => visible(node) && !node.closest('.ashby-application-form-input-yesno'))
    const seen = new Set()
    for (const node of clickables) {
      const text = cleanLabel(node.innerText || node.value || node.getAttribute('aria-label') || '')
      if (!text || text.length > 80) continue
      const key = fold(text)
      if (seen.has(key)) continue
      seen.add(key)
      emitElement(found, node, { role: node.tagName === 'A' ? 'link' : 'button', label: text, control: node, required: false })
    }

    const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
    const looksLikeForm = found.some((row) => ['textbox', 'textarea', 'email', 'tel', 'combobox', 'select', 'radio', 'checkbox', 'yesno', 'file'].includes(row.role))
    const head = body.slice(0, 1600)
    const tail = body.length > 1600 ? body.slice(-1400) : ''
    const verifyHit = body.match(/verification code was sent[\s\S]{0,240}|enter the \d[- ]?character code[\s\S]{0,120}|8-character code[\s\S]{0,160}/i)
    return {
      url: location.href,
      title: document.title,
      text: [head, tail, verifyHit?.[0] ?? ''].filter(Boolean).join('\n'),
      looksLikeForm,
      elements: found,
    }
  }

  async function fillSelect(control, value) {
    if (!(control instanceof HTMLSelectElement)) return false
    const labels = Array.from(control.options).map((option) => option.label || option.textContent || option.value)
    const choice = pickOption(labels, value)
    if (!choice) return false
    const row = Array.from(control.options).find((option) => fold(option.label || option.text) === fold(choice) || option.value === choice)
    control.focus()
    if (row) control.value = row.value
    else return false
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
    return Boolean(control.value)
  }
  async function fillYesNo(node, value) {
    const wanted = yesNoWanted(value) || ( /^(yes|no)$/i.test(String(value)) ? String(value) : null)
    if (!wanted) return false
    const root = node.matches?.('.ashby-application-form-input-yesno') ? node : node.querySelector?.('.ashby-application-form-input-yesno') || node
    const button = Array.from(root.querySelectorAll('button')).find((item) => fold(cleanLabel(item.textContent || '')) === fold(wanted))
    if (!(button instanceof HTMLElement)) return false
    clickNode(button)
    await wait(80)
    return fold(committedFrom(node)) === fold(wanted)
  }
  async function fillChoice(node, value) {
    const wanted = fold(cleanLabel(yesNoWanted(value) || value))
    const self = node instanceof HTMLInputElement && (node.type === 'radio' || node.type === 'checkbox') ? [node] : []
    const nested = node instanceof Element ? Array.from(node.querySelectorAll('input[type="radio"], input[type="checkbox"]')) : []
    const inputs = [...self, ...nested]
    for (const input of inputs) {
      if (!(input instanceof HTMLInputElement)) continue
      const id = input.getAttribute('id')
      const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || '' : ''
      const wrap = input.closest('label')?.textContent || ''
      const blob = fold(cleanLabel(`${forLabel} ${wrap} ${input.value}`))
      if (blob === wanted || includesWord(blob, wanted) || scoreOption(value, blob) >= 70) {
        if (!input.checked) clickNode(input)
        return input.checked
      }
    }
    const button = Array.from(node.querySelectorAll('button, [role="radio"], label')).find((item) => {
      const text = fold(cleanLabel(item.textContent || ''))
      return text === wanted || text.startsWith(wanted)
    })
    if (button instanceof HTMLElement) return clickNode(button)
    return false
  }
  function dropdownCommitted(control) {
    if (isReactSelect(control)) {
      const wrap = control.closest('.field-wrapper, .select, .select-shell, .application-question') || control
      return selectedChoiceText(wrap, control)
    }
    return committedFrom(control)
  }
  async function fillDropdown(control, value) {
    if (!String(value || '').trim()) return false
    if (control instanceof HTMLSelectElement) return fillSelect(control, value)
    if (!(control instanceof HTMLInputElement) && control instanceof HTMLElement) {
      clickNode(control)
      await wait(250)
      const listed = listedOptions()
      const choice = pickOption(listed, value) || (listed.length === 1 && /agree|yes|i consent/i.test(listed[0] || '') ? listed[0] : null)
      if (choice && clickListedOption(choice)) {
        await wait(160)
        return Boolean(dropdownCommitted(control))
      }
      return false
    }
    if (!(control instanceof HTMLInputElement)) return false
    const previousMenu = activeMenu
    activeMenu = control.closest('.iti') ? 'phone' : 'select'
    const inputCounts = () => dropdownCommitted(control) || (!isReactSelect(control) && valueMatches(control.value, value))
    try {
      await openFlyout(control)
      let listed = listedOptions()
      let choice = pickOption(listed, value) || (listed.length === 1 ? listed[0] : null)
      if (choice && clickListedOption(choice)) {
        await wait(180)
        if (inputCounts()) return true
      }
      const phoneMenu = activeMenu === 'phone' || /india|\+91/i.test(String(value))
      const queries = phoneMenu
        ? [value, 'India', '+91', 'IN'].filter((item, index, all) => item && all.indexOf(item) === index)
        : [value, String(value).split(',')[0]].filter(Boolean)
      for (const query of queries.slice(0, 3)) {
        await openFlyout(control)
        await typeQuery(control, query)
        await wait(2000)
        listed = listedOptions()
        if (!listed.length) {
          await typeQuery(control, query)
          await wait(2000)
          listed = listedOptions()
        }
        choice = pickOption(listed, query) || pickOption(listed, value) || (listed.length === 1 ? listed[0] : null)
        if (choice && clickListedOption(choice)) {
          await wait(180)
          if (dropdownCommitted(control) || (!isReactSelect(control) && valueMatches(control.value, choice))) return true
        }
        if (listed.length === 1 && listed[0] && clickListedOption(listed[0])) {
          await wait(180)
          if (dropdownCommitted(control)) return true
        }
        if (listed.length) {
          control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
          control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          await wait(120)
          if (dropdownCommitted(control)) return true
        }
      }
      return Boolean(dropdownCommitted(control))
    } finally {
      activeMenu = previousMenu
    }
  }
  function fillText(control, value) {
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      const next = control instanceof HTMLInputElement && control.type === 'tel' ? nationalPhoneNumber(value) : value
      control.focus()
      setNativeValue(control, next)
      control.dispatchEvent(new Event('blur', { bubbles: true }))
      control.blur()
      return valueMatches(control.value, next) || valueMatches(control.value, value)
    }
    if (control instanceof HTMLElement && control.getAttribute('contenteditable') === 'true') {
      control.focus()
      control.innerText = value
      control.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
      return valueMatches(control.innerText || '', value)
    }
    return false
  }
  function fillCheckbox(node, value) {
    const wanted = /^(true|yes)$/i.test(String(value).trim())
    const box = node instanceof HTMLInputElement && node.type === 'checkbox'
      ? node
      : node.querySelector?.('input[type="checkbox"]')
    if (!(box instanceof HTMLInputElement)) return false
    if (box.checked !== wanted) clickNode(box)
    return box.checked === wanted
  }

  async function harvest(id) {
    const node = byId(id)
    if (!node) return []
    const control = controlFor(node)
    if (control instanceof HTMLSelectElement) {
      return Array.from(control.options).map((option) => (option.label || option.textContent || '').trim()).filter((text) => text && !isPlaceholderChoice(text))
    }
    if (!(control instanceof HTMLElement)) return []
    const previousMenu = activeMenu
    activeMenu = control.closest?.('.iti') ? 'phone' : 'select'
    try {
      await openFlyout(control)
      let options = listedOptions()
      if (!options.length && control instanceof HTMLInputElement) {
        await typeQuery(control, 'a')
        await wait(200)
        options = listedOptions()
      }
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) setNativeValue(control, '')
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return options
    } finally {
      activeMenu = previousMenu
    }
  }

  async function act(command) {
    const id = command?.id
    const op = command?.op
    const value = command?.value == null ? '' : String(command.value)
    const node = byId(id)
    if (!node) return { ok: false, error: 'missing_id', id }
    const control = controlFor(node)
    if (op === 'click') {
      const ok = clickNode(node instanceof HTMLElement ? node : control)
      await wait(120)
      return { ok, id, committed: committedFrom(node) }
    }
    if (op === 'clear') {
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) setNativeValue(control, '')
      return { ok: true, id, committed: '' }
    }
    if (op === 'harvest') {
      const options = await harvest(id)
      return { ok: true, id, options }
    }
    if (op === 'upload') {
      return { ok: Boolean(control instanceof HTMLInputElement && control.type === 'file'), id, role: 'file' }
    }
    if (op === 'fill' || op === 'select' || op === 'check') {
      const role = roleOf(node, control)
      let ok = false
      if (role === 'yesno') ok = await fillYesNo(node, value)
      else if (role === 'select') ok = await fillSelect(control, value)
      else if (role === 'combobox') ok = await fillDropdown(control, value)
      else if (role === 'radio' || (role === 'checkbox' && optionsOf(node, control, role).length > 1)) ok = await fillChoice(node, value)
      else if (role === 'checkbox') ok = fillCheckbox(node, value)
      else ok = fillText(control, value)
      const committed = committedFrom(node)
      const filled = Boolean(committed) && (role !== 'textbox' && role !== 'textarea' && role !== 'email' && role !== 'tel' ? true : valueMatches(committed, value) || Boolean(committed))
      return { ok: ok && (filled || role === 'checkbox'), id, committed, filled }
    }
    return { ok: false, error: 'unknown_op', id }
  }

  window.addEventListener('apply-pilot-cmd', (event) => {
    const detail = event.detail || {}
    const id = detail.id
    const cmd = detail.cmd
    Promise.resolve()
      .then(async () => {
        if (cmd === 'snapshot' || cmd === 'inventory') return snapshot()
        if (cmd === 'act') return act(detail.args || {})
        if (cmd === 'looksLikeForm') return snapshot().looksLikeForm
        throw new Error('unknown_cmd')
      })
      .then((payload) => {
        window.dispatchEvent(new CustomEvent('apply-pilot-result', { detail: { id, payload } }))
      })
      .catch((err) => {
        window.dispatchEvent(new CustomEvent('apply-pilot-result', { detail: { id, error: String(err) } }))
      })
  })

  const api = { version: 16, snapshot, act, harvest }
  window.__APPLY_PILOT__ = api
  window.__HUNTLY_APPLY__ = api
})()
