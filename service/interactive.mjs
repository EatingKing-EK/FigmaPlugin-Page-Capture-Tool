export async function discoverInteractivePoints(page, maxCount) {
  return page.evaluate((limit) => {
    const selector =
      'a, button, input, summary, [role="button"], [role="link"], [onclick], [tabindex]'

    function isElementVisible(element) {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.pointerEvents !== 'none' &&
        rect.width >= 20 &&
        rect.height >= 20
      )
    }

    function isInteractiveRoot(element) {
      const nearest = element.parentElement?.closest(selector)
      return !nearest || nearest === element
    }

    function isMeaningfulElement(element) {
      const tagName = element.tagName.toLowerCase()
      const role = (element.getAttribute('role') || '').toLowerCase()
      const inputType = (element.getAttribute('type') || '').toLowerCase()
      const tabIndex = element.tabIndex
      const style = window.getComputedStyle(element)

      if (tagName === 'input') {
        return ['button', 'submit', 'checkbox', 'radio', 'reset', 'image'].includes(
          inputType,
        )
      }

      return (
        ['a', 'button', 'summary'].includes(tagName) ||
        role === 'button' ||
        role === 'link' ||
        element.hasAttribute('onclick') ||
        style.cursor === 'pointer' ||
        tabIndex >= 0
      )
    }

    function extractLabel(element) {
      const textCandidates = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('alt'),
        element.getAttribute('placeholder'),
        'value' in element ? element.value : '',
        element.innerText,
        element.textContent,
      ]

      const label = textCandidates
        .filter(Boolean)
        .map((value) => String(value).replace(/\s+/g, ' ').trim())
        .find((value) => value.length > 0)

      if (!label) {
        return ''
      }

      return label.slice(0, 80)
    }

    function buildCssSelector(element) {
      if (
        element.id &&
        document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1
      ) {
        return `#${CSS.escape(element.id)}`
      }

      const parts = []
      let currentElement = element

      while (currentElement && currentElement !== document.body) {
        const tagName = currentElement.tagName.toLowerCase()
        const parent = currentElement.parentElement

        if (!parent) {
          break
        }

        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === currentElement.tagName,
        )
        const index = siblings.indexOf(currentElement) + 1
        parts.unshift(`${tagName}:nth-of-type(${index})`)
        currentElement = parent
      }

      return `body > ${parts.join(' > ')}`
    }

    return Array.from(document.querySelectorAll(selector))
      .filter((element) => isInteractiveRoot(element))
      .filter((element) => isElementVisible(element))
      .filter((element) => isMeaningfulElement(element))
      .map((element, index) => {
        const rect = element.getBoundingClientRect()

        return {
          index,
          selector: buildCssSelector(element),
          label: extractLabel(element),
          href: element.getAttribute('href') || '',
          tagName: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          x: Math.round(rect.x),
          y: Math.round(rect.y + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      })
      .sort((left, right) => {
        if (left.y === right.y) {
          return left.x - right.x
        }

        return left.y - right.y
      })
      .slice(0, limit)
  }, maxCount)
}
