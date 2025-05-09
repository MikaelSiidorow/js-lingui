import { format as formatDate } from "date-fns"
import { po as poParser } from "gettext-parser"
import type {
  GetTextTranslations,
  GetTextTranslationRecord,
  GetTextTranslation,
  GetTextComment,
} from "gettext-parser"
import { CatalogFormatter, CatalogType, MessageType } from "@lingui/conf"
import { generateMessageId } from "@lingui/message-utils/generateMessageId"
import { normalizePlaceholderValue } from "./utils"

const splitOrigin = (origin: string) => {
  const [file, line] = origin.split(":")
  return [file, line ? Number(line) : null] as [file: string, line: number]
}

const splitMultiLineComments = (comments: string[]) => {
  return comments.flatMap((comment) =>
    comment.includes("\n")
      ? comment
          .split("\n")
          .map((slice) => slice.trim())
          .filter(Boolean)
      : comment
  )
}

/**
 * @internal
 */
export type POCatalogExtra = {
  translatorComments?: string[]
  flags?: string[]
}

const joinOrigin = (origin: [file: string, line?: number]): string =>
  origin.join(":")

export type PoFormatterOptions = {
  /**
   * Print places where message is used
   *
   * @default true
   */
  origins?: boolean

  /**
   * Print line numbers in origins
   *
   * @default true
   */
  lineNumbers?: boolean

  /**
   * Print `js-lingui-id: Xs4as` statement in extracted comments section
   *
   * @default false
   */
  printLinguiId?: boolean

  /**
   * By default, the po-formatter treats the pair `msgid` + `msgctx` as the source
   * for generating an ID by hashing its value.
   *
   * For messages with explicit IDs, the formatter adds a special comment `js-lingui-explicit-id` as a flag.
   * When this flag is present, the formatter will use the `msgid` as-is without any additional processing.
   *
   * Set this option to true if you exclusively use explicit-ids in your project.
   *
   * https://lingui.dev/tutorials/explicit-vs-generated-ids#using-custom-id
   *
   * @default false
   */
  explicitIdAsDefault?: boolean

  /**
   * Custom attributes to append to the PO file header
   *
   * @default {}
   */
  customHeaderAttributes?: { [key: string]: string }

  /**
   * Print values for unnamed placeholders as comments for each message.
   *
   * This can give more context to translators for better translations.
   *
   * By default first 3 placeholders are shown.
   *
   * Example:
   *
   * ```js
   * t`Hello ${user.name} ${value}`
   * ```
   *
   * This will be extracted as
   *
   * ```po
   * #. placeholder {0}: user.name
   * msgid "Hello {0} {value}"
   * ```
   *
   * @default true
   */
  printPlaceholdersInComments?: boolean | { limit?: number }
}

function isGeneratedId(id: string, message: MessageType): boolean {
  return id === generateMessageId(message.message, message.context)
}

function getCreateHeaders(
  language: string,
  customHeaderAttributes: PoFormatterOptions["customHeaderAttributes"]
): GetTextTranslations["headers"] {
  return {
    "POT-Creation-Date": formatDate(new Date(), "yyyy-MM-dd HH:mmxxxx"),
    "MIME-Version": "1.0",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Transfer-Encoding": "8bit",
    "X-Generator": "@lingui/cli",
    ...(language ? { Language: language } : {}),
    ...(customHeaderAttributes ?? {}),
  }
}

const EXPLICIT_ID_FLAG = "js-lingui-explicit-id"
const GENERATED_ID_FLAG = "js-lingui-generated-id"

const serialize = (
  catalog: CatalogType,
  options: PoFormatterOptions
): GetTextTranslationRecord => {
  const translations: GetTextTranslationRecord = {}

  Object.keys(catalog).forEach((id) => {
    const message: MessageType<POCatalogExtra> = catalog[id]

    const item: GetTextTranslation = {
      msgid: "", // Will be set below
      msgstr: [message.translation || ""], // Ensure msgstr is always an array, and provide empty string for null/undefined
    }

    const comments: GetTextComment = {}

    // Extracted comments
    const extractedComments: string[] = []
    if (message.comments?.length) {
      extractedComments.push(...splitMultiLineComments(message.comments))
    }

    const _isGeneratedId = isGeneratedId(id, message)

    if (_isGeneratedId) {
      item.msgid = message.message || "" // Ensure msgid is not undefined

      if (options.explicitIdAsDefault) {
        if (!extractedComments.includes(GENERATED_ID_FLAG)) {
          extractedComments.push(GENERATED_ID_FLAG)
        }
      }

      if (options.printLinguiId) {
        if (!extractedComments.find((c) => c.includes("js-lingui-id"))) {
          extractedComments.push(`js-lingui-id: ${id}`)
        }
      }
    } else {
      if (!options.explicitIdAsDefault) {
        if (!extractedComments.includes(EXPLICIT_ID_FLAG)) {
          extractedComments.push(EXPLICIT_ID_FLAG)
        }
      }
      item.msgid = id
    }

    if (options.printPlaceholdersInComments !== false) {
      const existingPlaceholderComments = extractedComments.filter(
        (comment) => !comment.startsWith("placeholder ")
      )
      extractedComments.length = 0
      extractedComments.push(...existingPlaceholderComments)

      const limit =
        typeof options.printPlaceholdersInComments === "object" &&
        options.printPlaceholdersInComments.limit
          ? options.printPlaceholdersInComments.limit
          : 3

      if (message.placeholders) {
        Object.entries(message.placeholders).forEach(([name, value]) => {
          if (/^\d+$/.test(name)) {
            value.slice(0, limit).forEach((entry) => {
              extractedComments.push(
                `placeholder {${name}}: ${normalizePlaceholderValue(entry)}`
              )
            })
          }
        })
      }
    }

    if (extractedComments.length > 0) {
      comments.extracted = extractedComments.join("\n")
    }

    // Translator comments
    if (message.extra?.translatorComments?.length) {
      comments.translator = splitMultiLineComments(
        message.extra.translatorComments
      ).join("\n")
    }

    // Origins (references)
    if (options.origins !== false && message.origin?.length) {
      const references = message.origin.map(
        options.lineNumbers === false ? ([path]) => path : joinOrigin
      )
      if (references.length > 0) {
        comments.reference = references.join("\n")
      }
    }

    // Flags
    if (message.extra?.flags?.length) {
      comments.flag = message.extra.flags.join(" ")
    }

    if (Object.keys(comments).length > 0) {
      item.comments = comments
    }

    if (message.context) {
      item.msgctxt = message.context
    }

    if (message.obsolete) {
      item.obsolete = true
    }

    const contextKey = item.msgctxt || ""
    if (!translations[contextKey]) {
      translations[contextKey] = {}
    }
    translations[contextKey][item.msgid] = item
  })

  return translations
}

function deserialize(
  translations: GetTextTranslationRecord,
  options: PoFormatterOptions
): CatalogType {
  const catalog: CatalogType<POCatalogExtra> = {}

  for (const msgctxt in translations) {
    const contextTranslations = translations[msgctxt]
    for (const originalMsgId in contextTranslations) {
      const item = contextTranslations[originalMsgId]

      const comments = item.comments || {}
      const extractedComments = comments.extracted
        ? comments.extracted.split("\n")
        : []
      const translatorComments = comments.translator
        ? comments.translator.split("\n")
        : []
      const flags = comments.flag ? comments.flag.split(" ") : []
      const references = comments.reference
        ? comments.reference.split("\n")
        : []

      const message: MessageType<POCatalogExtra> = {
        translation: item.msgstr[0] || "", // Ensure translation is not undefined
        comments: extractedComments,
        context: item.msgctxt || null,
        obsolete: item.obsolete || flags.includes("obsolete"), // `gettext-parser` might put obsolete in flags
        origin: references.map((ref) => splitOrigin(ref)),
        extra: {
          translatorComments: translatorComments,
          flags: flags.filter((f) => f !== "obsolete"), // Remove obsolete from flags if it was there
        },
      }

      let id = item.msgid

      if (
        options.explicitIdAsDefault
          ? extractedComments.includes(GENERATED_ID_FLAG)
          : !extractedComments.includes(EXPLICIT_ID_FLAG)
      ) {
        id = generateMessageId(item.msgid, item.msgctxt)
        message.message = item.msgid
      }
      // If it's an explicit ID, message.message is not set here,
      // it's assumed that the ID itself is the message key/text.
      // Or, if not, the user should ensure it's correctly handled in their workflow.
      // The original code didn't explicitly set message.message for explicit IDs.

      catalog[id] = message
    }
  }
  return catalog
}

export function formatter(options: PoFormatterOptions = {}): CatalogFormatter {
  options = {
    origins: true,
    lineNumbers: true,
    ...options,
  }

  return {
    catalogExtension: ".po",
    templateExtension: ".pot",

    parse(content): CatalogType {
      const po = poParser.parse(content, { defaultCharset: "utf-8" })
      return deserialize(po.translations, options)
    },

    serialize(catalog, ctx): string {
      let headers = getCreateHeaders(ctx.locale, options.customHeaderAttributes)
      const existingTranslations: GetTextTranslationRecord | undefined =
        undefined

      if (ctx.existing) {
        try {
          const existingPo = poParser.parse(ctx.existing, {
            defaultCharset: "utf-8",
          })
          headers = existingPo.headers // Prefer existing headers
        } catch (e) {
          console.warn(
            "Failed to parse existing .po file, creating a new one.",
            e
          )
        }
      }

      const translations = serialize(catalog, options)

      const poData: GetTextTranslations = {
        charset: "utf-8",
        headers: headers,
        translations: translations,
      }

      const buffer = poParser.compile(poData, { sort: true })
      return buffer.toString("utf-8")
    },
  }
}
