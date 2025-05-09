import { parse as parseIcu, Select, SelectCase } from "@messageformat/parser"
import pluralsCldr from "plurals-cldr"
import { po as poParser } from "gettext-parser"
import type {
  GetTextTranslations,
  GetTextTranslationRecord,
  GetTextTranslation,
  GetTextComment,
} from "gettext-parser"
import gettextPlurals from "node-gettext/lib/plurals"

import type {
  CatalogFormatter,
  CatalogType,
  MessageType,
  CatalogContext,
} from "@lingui/conf"
import { generateMessageId } from "@lingui/message-utils/generateMessageId"
import { formatter as poFormatter } from "@lingui/format-po"
import type { PoFormatterOptions } from "@lingui/format-po"
import { getCldrPluralSamples } from "./plural-samples"

export type PoGettextFormatterOptions = PoFormatterOptions & {
  disableSelectWarning?: boolean
  customICUPrefix?: string
}

const cldrSamples = getCldrPluralSamples()

// Prefix that is used to identitify context information used by this module in PO's "extracted comments".
const DEFAULT_CTX_PREFIX = "js-lingui:"

// Constants for flags used by po.ts formatter, if needed for coordination
const EXPLICIT_ID_FLAG = "js-lingui-explicit-id"
const GENERATED_ID_FLAG = "js-lingui-generated-id"

// Attempts to turn a single tokenized ICU plural case back into a string.
function stringifyICUCase(icuCase: SelectCase): string {
  return icuCase.tokens
    .map((token) => {
      if (token.type === "content") {
        return token.value
      } else if (token.type === "octothorpe") {
        return "#"
      } else if (token.type === "argument") {
        return "{" + token.arg + "}"
      } else {
        console.warn(
          `Unexpected token "${token}" while stringifying plural case "${icuCase}". Token will be ignored.`
        )
        return ""
      }
    })
    .join("")
}

const ICU_PLURAL_REGEX = /^{.*, plural, .*}$/
const ICU_SELECT_REGEX = /^{.*, select(Ordinal)?, .*}$/
const LINE_ENDINGS = /\r?\n/g

function serializePlurals(
  item: GetTextTranslation,
  message: MessageType,
  id: string,
  isGeneratedId: boolean,
  options: PoGettextFormatterOptions
): GetTextTranslation {
  const icuMessage = message.message
  const ctxPrefix = options.customICUPrefix || DEFAULT_CTX_PREFIX

  if (!icuMessage) {
    return item
  }

  const _simplifiedMessage = icuMessage.replace(LINE_ENDINGS, " ")

  if (ICU_PLURAL_REGEX.test(_simplifiedMessage)) {
    try {
      const messageAst = parseIcu(icuMessage)[0] as Select

      if (
        messageAst.cases.some((icuCase) =>
          icuCase.tokens.some((token) => token.type === "plural")
        )
      ) {
        console.warn(
          `Nested plurals cannot be expressed with gettext plurals. ` +
            `Message with key "%s" will not be saved correctly.`,
          id
        )
      }

      const params = new URLSearchParams()
      params.set("pluralize_on", messageAst.arg)

      if (isGeneratedId) {
        item.msgid = stringifyICUCase(messageAst.cases[0])
        item.msgid_plural = stringifyICUCase(
          messageAst.cases[messageAst.cases.length - 1]
        )
        params.set("icu", icuMessage)
      } else {
        item.msgid_plural = id + "_plural"
      }

      params.sort()

      if (!item.comments) {
        item.comments = {}
      }
      const currentExtractedComments = item.comments.extracted
        ? item.comments.extracted.split("\n")
        : []
      currentExtractedComments.push(ctxPrefix + params.toString())
      item.comments.extracted = currentExtractedComments.join("\n")

      if (message.translation?.length > 0) {
        const ast = parseIcu(message.translation)[0] as Select
        if (ast.cases == null) {
          console.warn(
            `Found translation without plural cases for key "${id}". ` +
              `This likely means that a translated .po file misses multiple msgstr[] entries for the key. ` +
              `Translation found: "${message.translation}"`
          )
          item.msgstr = [message.translation]
        } else {
          item.msgstr = ast.cases.map(stringifyICUCase)
        }
      } else {
        if (item.msgid_plural) {
          item.msgstr = []
        }
      }
    } catch (e) {
      console.error(`Error parsing message ICU for key "${id}":`, e)
    }
  } else {
    if (
      !options.disableSelectWarning &&
      ICU_SELECT_REGEX.test(_simplifiedMessage)
    ) {
      console.warn(
        `ICU 'select' and 'selectOrdinal' formats cannot be expressed natively in gettext format. ` +
          `Item with key "%s" will be included in the catalog as raw ICU message. ` +
          `To disable this warning, include '{ disableSelectWarning: true }' in the config's 'formatOptions'`,
        id
      )
    }
    item.msgstr = [message.translation || ""]
  }
  return item
}

type GettextPluralsInfo = {
  nplurals: number
  pluralsFunc: (n: number) => number
}

const getPluralCases = (
  lang: string,
  pluralFormsHeader: string
): string[] | undefined => {
  let gettextPluralsInfo: GettextPluralsInfo

  if (pluralFormsHeader) {
    gettextPluralsInfo = parsePluralFormsFn(pluralFormsHeader)
  }

  const [correctLang] = lang.split(/[-_]/g)

  if (!gettextPluralsInfo) {
    gettextPluralsInfo = gettextPlurals[correctLang]
  }

  if (!gettextPluralsInfo) {
    if (lang !== "pseudo") {
      console.warn(
        `No plural rules found for language "${lang}". Please add a Plural-Forms header.`
      )
    }
    return undefined
  }

  const cases: string[] = [...Array(pluralsCldr.forms(correctLang).length)]

  for (const form of pluralsCldr.forms(correctLang)) {
    const samples = cldrSamples[correctLang][form]
    const pluralForm = Number(
      gettextPluralsInfo.pluralsFunc(Number(samples[0]))
    )

    cases[pluralForm] = form
  }

  return cases
}

function parsePluralFormsFn(pluralFormsHeader: string): GettextPluralsInfo {
  const [npluralsExpr, expr] = pluralFormsHeader.split(";")

  try {
    const nplurals = new Function(npluralsExpr + "; return nplurals;")()
    const pluralsFunc = new Function(
      "n",
      expr + "; return plural;"
    ) as GettextPluralsInfo["pluralsFunc"]

    return {
      nplurals,
      pluralsFunc,
    }
  } catch (e) {
    console.warn(
      `Plural-Forms header has incorrect value: ${pluralFormsHeader}`
    )
    return undefined
  }
}

const convertPluralsToICU = (
  item: GetTextTranslation,
  pluralForms: string[],
  lang: string,
  ctxPrefix: string = DEFAULT_CTX_PREFIX
) => {
  const translationCount = item.msgstr.length
  const messageKey = item.msgid

  if (translationCount <= 1 && !item.msgid_plural) {
    return
  }

  if (!item.msgid_plural) {
    console.warn(
      `Multiple translations for item with key "%s" but missing 'msgid_plural' in catalog "${lang}". This is not supported and the plural cases will be ignored.`,
      messageKey
    )
    return
  }

  const itemComments = item.comments || {}
  let extractedCommentsArray = itemComments.extracted
    ? itemComments.extracted.split("\n")
    : []

  const contextCommentEntry = extractedCommentsArray.find((comment) =>
    comment.startsWith(ctxPrefix)
  )

  const contextComment = contextCommentEntry?.substring(ctxPrefix.length)
  const ctx = new URLSearchParams(contextComment)

  if (contextCommentEntry != null) {
    extractedCommentsArray = extractedCommentsArray.filter(
      (comment) => !comment.startsWith(ctxPrefix)
    )
    itemComments.extracted = extractedCommentsArray.join("\n")
    if (!itemComments.extracted) delete itemComments.extracted
  }

  const storedICU = ctx.get("icu")
  if (storedICU != null) {
    item.msgid = storedICU
  }

  if (item.msgstr.every((str) => str.length === 0)) {
    return
  }

  if (pluralForms == null) {
    console.warn(
      `Multiple translations for item with key "%s" in language "${lang}", but no plural cases were found. ` +
        `This prohibits the translation of .po plurals into ICU plurals. Pluralization will not work for this key.`,
      item.msgid
    )
    return
  }

  const pluralCount = pluralForms.length
  if (translationCount > pluralCount) {
    console.warn(
      `More translations provided (${translationCount}) for item with key "%s" in language "${lang}" than there are plural cases available (${pluralCount}). ` +
        `This will result in not all translations getting picked up.`,
      item.msgid
    )
  }

  const pluralClauses = item.msgstr
    .slice(0, pluralCount)
    .map((str, index) =>
      pluralForms[index] ? pluralForms[index] + " {" + str + "}" : ""
    )
    .join(" ")
    .trim()

  let pluralizeOn = ctx.get("pluralize_on")
  if (!pluralizeOn) {
    console.warn(
      `Unable to determine plural placeholder name for item with key "%s" in language "${lang}" (should be stored in a comment starting with "#. ${ctxPrefix}"), assuming "count".`,
      item.msgid
    )
    pluralizeOn = "count"
  }

  item.msgstr = ["{" + pluralizeOn + ", plural, " + pluralClauses + "}"]
  delete item.msgid_plural
}

export function formatter(
  options: PoGettextFormatterOptions = {}
): CatalogFormatter {
  const mergedOptions = {
    origins: true,
    lineNumbers: true,
    ...options,
  }

  const basePoFormatter = poFormatter(mergedOptions)

  return {
    catalogExtension: ".po",
    templateExtension: ".pot",

    parse(content: string, ctx: CatalogContext): CatalogType {
      const poFile = poParser.parse(content)

      const lang = poFile.headers.Language || ctx.locale || ""
      const pluralFormsHeader = poFile.headers["Plural-Forms"] || ""
      const pluralCases = getPluralCases(lang, pluralFormsHeader)

      for (const msgctxt in poFile.translations) {
        const contextTranslations = poFile.translations[msgctxt]
        for (const originalMsgId in contextTranslations) {
          const item = contextTranslations[originalMsgId]
          convertPluralsToICU(
            item,
            pluralCases,
            lang,
            mergedOptions.customICUPrefix
          )
        }
      }

      const modifiedPoString = poParser.compile(poFile).toString("utf-8")
      return basePoFormatter.parse(modifiedPoString, ctx)
    },

    serialize(catalog: CatalogType, ctx: CatalogContext): string {
      const basePoString = basePoFormatter.serialize(catalog, ctx)

      const poFile = poParser.parse(basePoString)
      const newTranslations: GetTextTranslationRecord = {}

      for (const msgctxtKey in poFile.translations) {
        const contextOriginalId = msgctxtKey || ""
        if (!newTranslations[contextOriginalId]) {
          newTranslations[contextOriginalId] = {}
        }
        const contextTranslations = poFile.translations[contextOriginalId]

        for (const originalMsgId in contextTranslations) {
          let item = contextTranslations[originalMsgId]

          const itemComments = item.comments?.extracted?.split("\n") || []

          let message: MessageType | undefined = undefined
          let catalogKey: string = ""
          let isGeneratedIdForPlurals: boolean = false

          const isExplicitlyMarked = itemComments.includes(EXPLICIT_ID_FLAG)
          const isGeneratedMarked = itemComments.includes(GENERATED_ID_FLAG)

          if (mergedOptions.explicitIdAsDefault) {
            if (isGeneratedMarked) {
              catalogKey = generateMessageId(item.msgid, item.msgctxt)
              isGeneratedIdForPlurals = true
            } else {
              catalogKey = item.msgid
              isGeneratedIdForPlurals = false
            }
          } else {
            if (isExplicitlyMarked) {
              catalogKey = item.msgid
              isGeneratedIdForPlurals = false
            } else {
              catalogKey = generateMessageId(item.msgid, item.msgctxt)
              isGeneratedIdForPlurals = true
            }
          }
          message = catalog[catalogKey]

          if (!message) {
            let found = false
            for (const catId in catalog) {
              const msgEntry = catalog[catId]
              if (mergedOptions.explicitIdAsDefault) {
                if (
                  catId === item.msgid &&
                  (msgEntry.context || "") === (item.msgctxt || "")
                ) {
                  message = msgEntry
                  catalogKey = catId
                  isGeneratedIdForPlurals = false
                  found = true
                  break
                }
              } else {
                if (
                  generateMessageId(msgEntry.message, msgEntry.context) ===
                    generateMessageId(item.msgid, item.msgctxt) &&
                  (msgEntry.context || "") === (item.msgctxt || "")
                ) {
                  message = msgEntry
                  catalogKey = catId
                  isGeneratedIdForPlurals = true
                  found = true
                  break
                }
                if (
                  catId === item.msgid &&
                  (msgEntry.context || "") === (item.msgctxt || "")
                ) {
                  message = msgEntry
                  catalogKey = catId
                  isGeneratedIdForPlurals = false
                  found = true
                  break
                }
              }
            }
            if (!found) {
              console.warn(
                `Could not find message in catalog for msgid="${
                  item.msgid
                }" (context="${item.msgctxt || ""}"). ` +
                  `Pluralization might be incorrect for this entry.`
              )
              newTranslations[contextOriginalId][originalMsgId] = item
              continue
            }
          }

          if (
            !isGeneratedIdForPlurals &&
            !message.message &&
            catalogKey === item.msgid
          ) {
            message.message = catalogKey
          }

          item = serializePlurals(
            item,
            message,
            catalogKey,
            isGeneratedIdForPlurals,
            mergedOptions
          )
          newTranslations[contextOriginalId][originalMsgId] = item
        }
      }
      poFile.translations = newTranslations

      if (!poFile.headers["Plural-Forms"] && ctx.locale) {
      }

      return poParser.compile(poFile, { sort: true }).toString("utf-8")
    },
  }
}
