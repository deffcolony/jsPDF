/**
 * @license
 * jsPDF PDF/A-3 and Associated Files Plugin
 *
 * Licensed under the MIT License.
 * http://opensource.org/licenses/mit-license
 */

import { jsPDF } from "../jspdf.js";
import { atob } from "../libs/AtobBtoa.js";

/**
 * PDF/A-3 and Associated Files plugin for jsPDF.
 * Enables PDF/A-3 compliant document generation and embedding of associated files (e.g. UBL XML invoices, Factur-X, ZUGFeRD).
 *
 * @name pdfa
 * @module
 */
(function(jsPDFAPI) {
  "use strict";

  /**
   * A small, valid ICC v4 sRGB destination profile (base64 encoded), bundled so that
   * PDF/A-3 documents always have a validator-recognizable RGB OutputIntent, even when
   * the caller does not supply their own ICC profile via options.outputIntent.destOutputProfile.
   * ISO 19005-3 (clause 6.2.4.3) requires DeviceRGB/DeviceGray content to be backed by either
   * a device independent Default colour space or a PDF/A OutputIntent containing a real ICC
   * destination profile; without this fallback, PDF/A-3 output would silently fail validation.
   * @private
   */
  var DEFAULT_SRGB_ICC_PROFILE_BASE64 =
    "AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oACQACABQACQAXYWNzcEFQUEwAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hh" +
    "ZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAg" +
    "Z1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMA" +
    "AAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAA" +
    "ADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFla" +
    "IAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPc" +
    "AADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcA" +
    "ALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAA" +
    "VHsAAEzNAACZmgAAJmYAAA9c";

  /**
   * Lazily decoded cache of the bundled default sRGB ICC profile bytes.
   * @private
   */
  var cachedDefaultIccProfileBytes = null;

  /**
   * Helper: Decode a base64 string into a Uint8Array of raw bytes.
   * @private
   */
  function base64ToUint8Array(base64) {
    var binaryStr = atob(base64);
    var bytes = new Uint8Array(binaryStr.length);
    for (var i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Helper: Returns the bundled default sRGB ICC destination profile bytes (decoded once, then cached).
   * @private
   */
  function getDefaultIccProfileBytes() {
    if (!cachedDefaultIccProfileBytes) {
      cachedDefaultIccProfileBytes = base64ToUint8Array(
        DEFAULT_SRGB_ICC_PROFILE_BASE64
      );
    }
    return cachedDefaultIccProfileBytes;
  }

  /**
   * Helper: Normalize ICC profile input (string / Uint8Array / ArrayBuffer / Array) into a Uint8Array of raw bytes.
   * Note: unlike binaryToString(), this treats string input as already being raw bytes (0-255 char codes),
   * which is required to correctly inspect/validate binary ICC profile data supplied as a "binary string".
   * @private
   */
  function toIccProfileBytes(data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data);
    }
    if (typeof data === "string") {
      var bytes = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 0xff;
      }
      return bytes;
    }
    return null;
  }

  /**
   * Helper: Read a 4-byte ASCII signature from an ICC profile byte array at the given offset.
   * @private
   */
  function readIccSignature(bytes, offset) {
    if (!bytes || bytes.length < offset + 4) {
      return "";
    }
    return String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
  }

  /**
   * Helper: Validate that the given bytes look like a well-formed ICC profile stream, per the
   * ICC.1 specification: a profile header is at least 128 bytes and its profile file signature
   * ('acsp') must appear at byte offset 36.
   * @private
   */
  function isValidIccProfile(bytes) {
    return Boolean(bytes) && bytes.length >= 132 && readIccSignature(bytes, 36) === "acsp";
  }

  /**
   * Helper: Determine the number of colour components (PDF /N entry) for an ICC profile from its
   * data colour space signature (ICC.1 header bytes 16-19), falling back to 3 (RGB) when unknown.
   * @private
   */
  function detectIccColorComponents(bytes) {
    var colorSpace = readIccSignature(bytes, 16).trim();
    switch (colorSpace) {
      case "GRAY":
        return 1;
      case "RGB":
        return 3;
      case "CMYK":
        return 4;
      default:
        return 3;
    }
  }

  /**
   * Helper: Left-pad number with zero.
   * @private
   */
  function padd2(num) {
    return (num < 10 ? "0" : "") + num;
  }

  /**
   * Helper: Escape XML special characters.
   * @private
   */
  function escapeXml(str) {
    if (typeof str !== "string") {
      str = String(str ?? "");
    }
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * Helper: Escape PDF string literals enclosed in parentheses.
   * @private
   */
  function escapePdfString(str) {
    if (typeof str !== "string") {
      str = String(str ?? "");
    }
    return str
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  /**
   * Helper: Escape PDF Name object (ISO 32000-1 clause 7.3.5).
   * Encodes characters that are not regular alphanumeric, dash, or underscore.
   * @private
   */
  function escapePdfName(str) {
    if (typeof str !== "string") {
      str = String(str ?? "");
    }
    return str.replace(/[^A-Za-z0-9_-]/g, function(char) {
      var hex = char.charCodeAt(0).toString(16).toUpperCase();
      return "#" + (hex.length < 2 ? "0" + hex : hex);
    });
  }

  /**
   * Helper: Format a Date object or date representation into ISO 8601 string (for XMP metadata).
   * @private
   */
  function formatIsoDate(date) {
    if (typeof date === "string") {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(date)) {
        return date;
      }
      date = new Date(date);
    }
    if (!(date instanceof Date) || isNaN(date.getTime())) {
      date = new Date();
    }
    return (
      date.getUTCFullYear() +
      "-" +
      padd2(date.getUTCMonth() + 1) +
      "-" +
      padd2(date.getUTCDate()) +
      "T" +
      padd2(date.getUTCHours()) +
      ":" +
      padd2(date.getUTCMinutes()) +
      ":" +
      padd2(date.getUTCSeconds()) +
      "Z"
    );
  }

  /**
   * Helper: Format a Date object into PDF date format (D:YYYYMMDDHHmmSSOHH'mm').
   * @private
   */
  function formatPdfDate(date) {
    if (typeof date === "string") {
      if (/^D:\d{14}/.test(date)) {
        return date;
      }
      date = new Date(date);
    }
    if (!(date instanceof Date) || isNaN(date.getTime())) {
      date = new Date();
    }
    var tzoffset = date.getTimezoneOffset();
    var tzsign = tzoffset < 0 ? "+" : "-";
    var tzhour = Math.floor(Math.abs(tzoffset / 60));
    var tzmin = Math.abs(tzoffset % 60);
    var timeZoneString = [tzsign, padd2(tzhour), "'", padd2(tzmin), "'"].join("");

    return [
      "D:",
      date.getFullYear(),
      padd2(date.getMonth() + 1),
      padd2(date.getDate()),
      padd2(date.getHours()),
      padd2(date.getMinutes()),
      padd2(date.getSeconds()),
      timeZoneString
    ].join("");
  }

  /**
   * Helper: Convert string / Uint8Array / ArrayBuffer to binary string (bytes 0-255).
   * @private
   */
  function binaryToString(data) {
    if (typeof data === "string") {
      return unescape(encodeURIComponent(data));
    }
    if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    } else if (Array.isArray(data)) {
      data = new Uint8Array(data);
    }
    if (data instanceof Uint8Array) {
      var CHUNK_SIZE = 8192;
      var result = "";
      for (var i = 0; i < data.length; i += CHUNK_SIZE) {
        result += String.fromCharCode.apply(
          null,
          data.subarray(i, Math.min(i + CHUNK_SIZE, data.length))
        );
      }
      return result;
    }
    return String(data ?? "");
  }

  /**
   * Helper: Guess MIME type from filename extension if not explicitly specified.
   * @private
   */
  function guessMimeType(filename) {
    var lower = (filename || "").toLowerCase();
    if (lower.endsWith(".xml")) return "application/xml";
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".csv")) return "text/csv";
    if (lower.endsWith(".txt")) return "text/plain";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    return "application/octet-stream";
  }

  /**
   * Helper: Normalize AFRelationship value according to ISO 19005-3 clause 6.8.
   * Predefined values: Source, Data, Alternative, Supplement, Unspecified.
   * @private
   */
  function normalizeAfRelationship(rel) {
    if (typeof rel !== "string" || rel.length === 0) {
      return "Alternative";
    }
    var lower = rel.toLowerCase();
    switch (lower) {
      case "alternative":
        return "Alternative";
      case "data":
        return "Data";
      case "source":
        return "Source";
      case "supplement":
        return "Supplement";
      case "unspecified":
        return "Unspecified";
      default:
        // Return capitalized or as-is if custom
        return rel.charAt(0).toUpperCase() + rel.slice(1);
    }
  }

  /**
   * Helper: Build complete, valid XMP metadata packet conforming to PDF/A-3 (ISO 19005-3).
   * @private
   */
  function buildPdfA3Xmp(options, docInfo) {
    options = options || {};
    docInfo = docInfo || {};

    var part = options.version || "3";
    var conformance = (options.conformance || "B").toUpperCase();
    // Normalize '3B' to 'B', '3A' to 'A', '3U' to 'U'
    if (conformance.startsWith("3")) {
      conformance = conformance.substring(1);
    }
    if (conformance !== "A" && conformance !== "U") {
      conformance = "B";
    }

    var title = options.title || docInfo.title || "";
    var author = options.author || options.creator || docInfo.author || "";
    var subject = options.subject || options.description || docInfo.subject || "";
    var keywords = options.keywords || docInfo.keywords || "";
    var creatorTool =
      options.creatorTool || docInfo.creator || "jsPDF " + jsPDF.version;
    var producer = options.producer || "jsPDF " + jsPDF.version;
    var isoCreateDate = formatIsoDate(
      options.creationDate || docInfo.creationDate || new Date()
    );
    var isoModDate = formatIsoDate(
      options.modDate || options.creationDate || docInfo.creationDate || new Date()
    );

    var xml = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n';
    xml += '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n';
    xml += '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n';

    // PDF/A Identification Schema
    xml += '    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n';
    xml += '      <pdfaid:part>' + escapeXml(String(part)) + '</pdfaid:part>\n';
    xml += '      <pdfaid:conformance>' + escapeXml(conformance) + '</pdfaid:conformance>\n';
    xml += '    </rdf:Description>\n';

    // Dublin Core Schema
    xml += '    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">\n';
    xml += '      <dc:format>application/pdf</dc:format>\n';
    if (title) {
      xml += '      <dc:title>\n';
      xml += '        <rdf:Alt>\n';
      xml += '          <rdf:li xml:lang="x-default">' + escapeXml(title) + '</rdf:li>\n';
      xml += '        </rdf:Alt>\n';
      xml += '      </dc:title>\n';
    }
    if (author) {
      xml += '      <dc:creator>\n';
      xml += '        <rdf:Seq>\n';
      xml += '          <rdf:li>' + escapeXml(author) + '</rdf:li>\n';
      xml += '        </rdf:Seq>\n';
      xml += '      </dc:creator>\n';
    }
    if (subject) {
      xml += '      <dc:description>\n';
      xml += '        <rdf:Alt>\n';
      xml += '          <rdf:li xml:lang="x-default">' + escapeXml(subject) + '</rdf:li>\n';
      xml += '        </rdf:Alt>\n';
      xml += '      </dc:description>\n';
    }
    xml += '      <dc:date>\n';
    xml += '        <rdf:Seq>\n';
    xml += '          <rdf:li>' + escapeXml(isoCreateDate) + '</rdf:li>\n';
    xml += '        </rdf:Seq>\n';
    xml += '      </dc:date>\n';
    xml += '    </rdf:Description>\n';

    // Adobe PDF Schema
    xml += '    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">\n';
    xml += '      <pdf:Producer>' + escapeXml(producer) + '</pdf:Producer>\n';
    if (keywords) {
      xml += '      <pdf:Keywords>' + escapeXml(keywords) + '</pdf:Keywords>\n';
    }
    xml += '    </rdf:Description>\n';

    // XMP Basic Schema
    xml += '    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n';
    xml += '      <xmp:CreatorTool>' + escapeXml(creatorTool) + '</xmp:CreatorTool>\n';
    xml += '      <xmp:CreateDate>' + escapeXml(isoCreateDate) + '</xmp:CreateDate>\n';
    xml += '      <xmp:ModifyDate>' + escapeXml(isoModDate) + '</xmp:ModifyDate>\n';
    xml += '      <xmp:MetadataDate>' + escapeXml(isoModDate) + '</xmp:MetadataDate>\n';
    xml += '    </rdf:Description>\n';

    // Factur-X / ZUGFeRD extension schema support
    if (options.facturx || options.zugferd) {
      var fx = options.facturx || options.zugferd;
      var isZugferd = Boolean(options.zugferd);
      var prefix = isZugferd ? "zf" : "fx";
      var ns =
        fx.urn ||
        (isZugferd
          ? "urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#"
          : "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#");
      var schemaName = isZugferd
        ? "ZUGFeRD PDFA Extension Schema"
        : "Factur-X PDFA Extension Schema";
      var docFileName =
        fx.documentFileName ||
        (isZugferd ? "zugferd-invoice.xml" : "factur-x.xml");
      var docType = fx.documentType || "INVOICE";
      var version = fx.version || (isZugferd ? "2.0" : "1.0");
      var conformanceLevel =
        fx.conformanceLevel || fx.profile || (isZugferd ? "COMFORT" : "EN 16931");

      xml += '    <rdf:Description rdf:about=""\n';
      xml += '        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"\n';
      xml += '        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"\n';
      xml += '        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">\n';
      xml += '      <pdfaExtension:schemas>\n';
      xml += '        <rdf:Bag>\n';
      xml += '          <rdf:li rdf:parseType="Resource">\n';
      xml += '            <pdfaSchema:schema>' + escapeXml(schemaName) + '</pdfaSchema:schema>\n';
      xml += '            <pdfaSchema:namespaceURI>' + escapeXml(ns) + '</pdfaSchema:namespaceURI>\n';
      xml += '            <pdfaSchema:prefix>' + escapeXml(prefix) + '</pdfaSchema:prefix>\n';
      xml += '            <pdfaSchema:property>\n';
      xml += '              <rdf:Seq>\n';
      xml += '                <rdf:li rdf:parseType="Resource">\n';
      xml += '                  <pdfaProperty:name>DocumentFileName</pdfaProperty:name>\n';
      xml += '                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>\n';
      xml += '                  <pdfaProperty:category>external</pdfaProperty:category>\n';
      xml += '                  <pdfaProperty:description>The name of the embedded invoice file</pdfaProperty:description>\n';
      xml += '                </rdf:li>\n';
      xml += '                <rdf:li rdf:parseType="Resource">\n';
      xml += '                  <pdfaProperty:name>DocumentType</pdfaProperty:name>\n';
      xml += '                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>\n';
      xml += '                  <pdfaProperty:category>external</pdfaProperty:category>\n';
      xml += '                  <pdfaProperty:description>The type of the hybrid document</pdfaProperty:description>\n';
      xml += '                </rdf:li>\n';
      xml += '                <rdf:li rdf:parseType="Resource">\n';
      xml += '                  <pdfaProperty:name>Version</pdfaProperty:name>\n';
      xml += '                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>\n';
      xml += '                  <pdfaProperty:category>external</pdfaProperty:category>\n';
      xml += '                  <pdfaProperty:description>The version of the invoice format</pdfaProperty:description>\n';
      xml += '                </rdf:li>\n';
      xml += '                <rdf:li rdf:parseType="Resource">\n';
      xml += '                  <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>\n';
      xml += '                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>\n';
      xml += '                  <pdfaProperty:category>external</pdfaProperty:category>\n';
      xml += '                  <pdfaProperty:description>The conformance level of the invoice</pdfaProperty:description>\n';
      xml += '                </rdf:li>\n';
      xml += '              </rdf:Seq>\n';
      xml += '            </pdfaSchema:property>\n';
      xml += '          </rdf:li>\n';
      xml += '        </rdf:Bag>\n';
      xml += '      </pdfaExtension:schemas>\n';
      xml += '    </rdf:Description>\n';

      xml += '    <rdf:Description rdf:about="" xmlns:' + prefix + '="' + escapeXml(ns) + '">\n';
      xml += '      <' + prefix + ':DocumentFileName>' + escapeXml(docFileName) + '</' + prefix + ':DocumentFileName>\n';
      xml += '      <' + prefix + ':DocumentType>' + escapeXml(docType) + '</' + prefix + ':DocumentType>\n';
      xml += '      <' + prefix + ':Version>' + escapeXml(version) + '</' + prefix + ':Version>\n';
      xml += '      <' + prefix + ':ConformanceLevel>' + escapeXml(conformanceLevel) + '</' + prefix + ':ConformanceLevel>\n';
      xml += '    </rdf:Description>\n';
    }

    // Custom Extension Schemas
    if (Array.isArray(options.schemas)) {
      for (var sIdx = 0; sIdx < options.schemas.length; sIdx++) {
        var s = options.schemas[sIdx];
        if (!s) continue;
        xml += '    <rdf:Description rdf:about=""\n';
        xml += '        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"\n';
        xml += '        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"\n';
        xml += '        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">\n';
        xml += '      <pdfaExtension:schemas>\n';
        xml += '        <rdf:Bag>\n';
        xml += '          <rdf:li rdf:parseType="Resource">\n';
        xml += '            <pdfaSchema:schema>' + escapeXml(s.schema || "") + '</pdfaSchema:schema>\n';
        xml += '            <pdfaSchema:namespaceURI>' + escapeXml(s.namespaceURI || "") + '</pdfaSchema:namespaceURI>\n';
        xml += '            <pdfaSchema:prefix>' + escapeXml(s.prefix || "") + '</pdfaSchema:prefix>\n';
        if (Array.isArray(s.properties)) {
          xml += '            <pdfaSchema:property>\n';
          xml += '              <rdf:Seq>\n';
          for (var pIdx = 0; pIdx < s.properties.length; pIdx++) {
            var prop = s.properties[pIdx];
            xml += '                <rdf:li rdf:parseType="Resource">\n';
            xml += '                  <pdfaProperty:name>' + escapeXml(prop.name || "") + '</pdfaProperty:name>\n';
            xml += '                  <pdfaProperty:valueType>' + escapeXml(prop.valueType || "Text") + '</pdfaProperty:valueType>\n';
            xml += '                  <pdfaProperty:category>' + escapeXml(prop.category || "external") + '</pdfaProperty:category>\n';
            xml += '                  <pdfaProperty:description>' + escapeXml(prop.description || "") + '</pdfaProperty:description>\n';
            xml += '                </rdf:li>\n';
          }
          xml += '              </rdf:Seq>\n';
          xml += '            </pdfaSchema:property>\n';
        }
        xml += '          </rdf:li>\n';
        xml += '        </rdf:Bag>\n';
        xml += '      </pdfaExtension:schemas>\n';
        xml += '    </rdf:Description>\n';

        if (s.prefix && s.namespaceURI && Array.isArray(s.properties)) {
          xml += '    <rdf:Description rdf:about="" xmlns:' + s.prefix + '="' + escapeXml(s.namespaceURI) + '">\n';
          for (var pValIdx = 0; pValIdx < s.properties.length; pValIdx++) {
            var pVal = s.properties[pValIdx];
            if (typeof pVal.value !== "undefined") {
              xml += '      <' + s.prefix + ':' + pVal.name + '>' + escapeXml(String(pVal.value)) + '</' + s.prefix + ':' + pVal.name + '>\n';
            }
          }
          xml += '    </rdf:Description>\n';
        }
      }
    }

    // Custom raw XMP XML injection
    if (typeof options.customXmp === "string" && options.customXmp.trim().length > 0) {
      xml += '    ' + options.customXmp.trim() + '\n';
    }

    xml += '  </rdf:RDF>\n';
    xml += '</x:xmpmeta>\n';
    xml += '<?xpacket end="w"?>';

    return xml;
  }

  /**
   * Internal state initialization helper.
   * @private
   */
  function getPdfAState(scope) {
    if (!scope.internal.__pdfa__) {
      scope.internal.__pdfa__ = {
        enabled: false,
        options: {},
        attachments: [],
        isSubscribed: false,
        xmpObjId: null,
        outputIntentObjId: null,
        iccProfileObjId: null
      };
    }
    return scope.internal.__pdfa__;
  }

  /**
   * Subscribe lifecycle hooks for PDF/A-3 and Associated Files emission.
   * @private
   */
  function subscribePdfAEvents() {
    var state = getPdfAState(this);
    if (state.isSubscribed) {
      return;
    }
    state.isSubscribed = true;

    // buildDocument hook: configure version, dates, properties
    this.internal.events.subscribe("buildDocument", function() {
      var pdfa = getPdfAState(this);
      if (pdfa.enabled) {
        if (typeof this.internal.setPDFVersion === "function") {
          this.internal.setPDFVersion("1.7");
        } else if (typeof this.setPdfVersion === "function") {
          this.setPdfVersion("1.7");
        }

        var opts = pdfa.options || {};
        var propsToSync = {};
        if (opts.title) propsToSync.title = opts.title;
        if (opts.author || opts.creator) propsToSync.author = opts.author || opts.creator;
        if (opts.subject || opts.description) propsToSync.subject = opts.subject || opts.description;
        if (opts.keywords) propsToSync.keywords = opts.keywords;
        if (opts.creator) propsToSync.creator = opts.creator;
        if (Object.keys(propsToSync).length > 0 && typeof this.setDocumentProperties === "function") {
          this.setDocumentProperties(propsToSync);
        }
        if (opts.creationDate && typeof this.setCreationDate === "function") {
          this.setCreationDate(opts.creationDate);
        }
      }
    });

    // postPutResources hook: emit EmbeddedFiles, Filespecs, OutputIntent, XMP Metadata
    this.internal.events.subscribe("postPutResources", function() {
      var pdfa = getPdfAState(this);

      // 1. Emit Embedded Files streams and Filespec dictionaries
      var attachments = pdfa.attachments || [];
      for (var i = 0; i < attachments.length; i++) {
        var att = attachments[i];
        var binaryData = binaryToString(att.content);

        // EmbeddedFile stream object
        var streamObjId = this.internal.newObject();
        att.streamObjId = streamObjId;

        var creationDateStr = formatPdfDate(att.creationDate || new Date());
        var modDateStr = formatPdfDate(att.modDate || att.creationDate || new Date());

        this.internal.write("<<");
        this.internal.write("/Type /EmbeddedFile");
        this.internal.write("/Subtype /" + escapePdfName(att.mimeType));
        this.internal.write("/Length " + binaryData.length);
        this.internal.write("/Params <<");
        this.internal.write("/Size " + binaryData.length);
        this.internal.write("/CreationDate (" + escapePdfString(creationDateStr) + ")");
        this.internal.write("/ModDate (" + escapePdfString(modDateStr) + ")");
        this.internal.write(">>");
        this.internal.write(">>");
        this.internal.write("stream");
        this.internal.write(binaryData);
        this.internal.write("endstream");
        this.internal.write("endobj");

        // Filespec dictionary object
        var filespecObjId = this.internal.newObject();
        att.filespecObjId = filespecObjId;

        this.internal.write("<<");
        this.internal.write("/Type /Filespec");
        this.internal.write("/F (" + escapePdfString(att.filename) + ")");
        this.internal.write(
          "/UF (" +
            escapePdfString(att.unicodeFilename || att.filename) +
            ")"
        );
        this.internal.write(
          "/EF << /F " +
            streamObjId +
            " 0 R /UF " +
            streamObjId +
            " 0 R >>"
        );
        if (att.description) {
          this.internal.write("/Desc (" + escapePdfString(att.description) + ")");
        }
        var rel = normalizeAfRelationship(att.relationship);
        this.internal.write("/AFRelationship /" + rel);
        this.internal.write(">>");
        this.internal.write("endobj");
      }

      // 2. OutputIntent dictionary object
      if (pdfa.enabled || (pdfa.options && pdfa.options.outputIntent)) {
        var oi = (pdfa.options && pdfa.options.outputIntent) || {};
        var condId = oi.outputConditionIdentifier || "sRGB IEC61966-2.1";
        var info = oi.info || "sRGB IEC61966-2.1";
        var regName = oi.registryName || "http://www.color.org";
        var subtype = oi.subtype || "GTS_PDFA1";
        var outputCondition = oi.outputCondition || oi.condition;

        // A validator-recognizable RGB destination profile is required for PDF/A-3 compliant
        // use of DeviceRGB/DeviceGray content (ISO 19005-3 clause 6.2.4.3). If the caller supplied
        // an ICC profile, use it (after validating it looks like a real ICC profile); otherwise
        // (or if it is invalid), fall back to the bundled default sRGB ICC profile so the
        // OutputIntent is always backed by a real, embedded destination profile.
        var iccProfileBytes = null;
        if (oi.destOutputProfile) {
          iccProfileBytes = toIccProfileBytes(oi.destOutputProfile);
          if (!isValidIccProfile(iccProfileBytes)) {
            if (
              typeof console !== "undefined" &&
              typeof console.warn === "function"
            ) {
              console.warn(
                "jsPDF PDF/A-3: options.outputIntent.destOutputProfile does not look like a " +
                  "valid ICC profile (missing 'acsp' signature). Falling back to the bundled " +
                  "default sRGB ICC profile to keep the PDF/A-3 OutputIntent valid."
              );
            }
            iccProfileBytes = null;
          }
        }
        if (!iccProfileBytes) {
          iccProfileBytes = getDefaultIccProfileBytes();
        }

        var destProfileRef = "";
        var iccData = binaryToString(iccProfileBytes);
        var iccN = oi.n || detectIccColorComponents(iccProfileBytes);
        var iccObjId = this.internal.newObject();
        pdfa.iccProfileObjId = iccObjId;
        this.internal.write("<<");
        this.internal.write("/N " + iccN);
        this.internal.write("/Length " + iccData.length);
        this.internal.write(">>");
        this.internal.write("stream");
        this.internal.write(iccData);
        this.internal.write("endstream");
        this.internal.write("endobj");
        destProfileRef = " /DestOutputProfile " + iccObjId + " 0 R";

        var outputIntentObjId = this.internal.newObject();
        pdfa.outputIntentObjId = outputIntentObjId;

        this.internal.write("<<");
        this.internal.write("/Type /OutputIntent");
        this.internal.write("/S /" + subtype);
        this.internal.write("/OutputConditionIdentifier (" + escapePdfString(condId) + ")");
        this.internal.write("/Info (" + escapePdfString(info) + ")");
        if (regName) {
          this.internal.write("/RegistryName (" + escapePdfString(regName) + ")");
        }
        if (outputCondition) {
          this.internal.write(
            "/OutputCondition (" + escapePdfString(outputCondition) + ")"
          );
        }
        if (destProfileRef) {
          this.internal.write(destProfileRef.trim());
        }
        this.internal.write(">>");
        this.internal.write("endobj");
      }

      // 3. XMP Metadata object for PDF/A-3
      if (pdfa.enabled) {
        // If doc.addMetadata was not manually invoked with custom raw XML
        var hasExistingMetadata =
          this.internal.__metadata__ &&
          this.internal.__metadata__.metadataObjectNumber;

        if (!hasExistingMetadata) {
          var docProps =
            (typeof this.internal.getDocumentProperties === "function"
              ? this.internal.getDocumentProperties()
              : {}) || {};
          var creationDate =
            typeof this.internal.getCreationDate === "function"
              ? this.internal.getCreationDate()
              : null;

          var xmpContent = buildPdfA3Xmp(pdfa.options, {
            title: docProps.title,
            author: docProps.author,
            subject: docProps.subject,
            keywords: docProps.keywords,
            creator: docProps.creator,
            creationDate: creationDate
          });

          var utf8Xmp = unescape(encodeURIComponent(xmpContent));
          var xmpObjId = this.internal.newObject();
          pdfa.xmpObjId = xmpObjId;

          this.internal.write(
            "<< /Type /Metadata /Subtype /XML /Length " + utf8Xmp.length + " >>"
          );
          this.internal.write("stream");
          this.internal.write(utf8Xmp);
          this.internal.write("endstream");
          this.internal.write("endobj");
        }
      }
    });

    // putCatalog hook: write /Metadata, /OutputIntents, /AF, and /Names entries
    this.internal.events.subscribe("putCatalog", function() {
      var pdfa = getPdfAState(this);

      // Metadata entry
      if (pdfa.xmpObjId) {
        var hasExistingMetadata =
          this.internal.__metadata__ &&
          this.internal.__metadata__.metadataObjectNumber;
        if (!hasExistingMetadata) {
          this.internal.write("/Metadata " + pdfa.xmpObjId + " 0 R");
        }
      }

      // OutputIntents entry
      if (pdfa.outputIntentObjId) {
        this.internal.write(
          "/OutputIntents [" + pdfa.outputIntentObjId + " 0 R]"
        );
      }

      // Associated Files / EmbeddedFiles entries
      var attachments = pdfa.attachments || [];
      if (attachments.length > 0) {
        // Sort attachments in ascending lexicographical order by filename for PDF Name tree
        var sorted = attachments.slice().sort(function(a, b) {
          if (a.filename < b.filename) return -1;
          if (a.filename > b.filename) return 1;
          return 0;
        });

        var afRefs = [];
        var namesArray = [];
        for (var i = 0; i < sorted.length; i++) {
          var att = sorted[i];
          if (att.filespecObjId) {
            afRefs.push(att.filespecObjId + " 0 R");
            namesArray.push(
              "(" +
                escapePdfString(att.filename) +
                ") " +
                att.filespecObjId +
                " 0 R"
            );
          }
        }

        if (afRefs.length > 0) {
          this.internal.write("/AF [" + afRefs.join(" ") + "]");
          this.internal.write(
            "/Names << /EmbeddedFiles << /Names [" +
              namesArray.join(" ") +
              "] >> >>"
          );
        }
      }
    });
  }

  // Handle constructor options on initialization
  jsPDFAPI.events.push([
    "initialized",
    function(options) {
      options = options || (this.internal && this.internal.options) || {};
      if (options.pdfa || options.pdfA3) {
        var pdfaOpt = options.pdfa || options.pdfA3;
        var optObj =
          typeof pdfaOpt === "object"
            ? pdfaOpt
            : typeof pdfaOpt === "string"
            ? { conformance: pdfaOpt }
            : {};
        this.enablePdfA3(optObj);
      }
    }
  ]);

  /**
   * Enables PDF/A-3 mode on the jsPDF instance.
   *
   * @name enablePdfA3
   * @function
   * @public
   * @param {Object|string} [options] PDF/A-3 configuration options or conformance string (e.g. '3b', 'B').
   * @param {string} [options.version='3'] PDF/A version part ('3').
   * @param {string} [options.conformance='B'] Conformance level ('B', 'A', 'U').
   * @param {string} [options.title] Document title.
   * @param {string} [options.author] Document author / creator.
   * @param {string} [options.subject] Document subject / description.
   * @param {string} [options.keywords] Document keywords.
   * @param {string} [options.creatorTool] Creator application name.
   * @param {string} [options.producer] Producer name.
   * @param {Date|string} [options.creationDate] Creation date.
   * @param {Date|string} [options.modDate] Modification date.
   * @param {Object} [options.outputIntent] OutputIntent configuration.
   * @param {string} [options.outputIntent.outputConditionIdentifier='sRGB IEC61966-2.1'] Output condition identifier.
   * @param {string} [options.outputIntent.info='sRGB IEC61966-2.1'] Human-readable output condition info.
   * @param {string} [options.outputIntent.registryName='http://www.color.org'] Output condition registry name.
   * @param {string} [options.outputIntent.subtype='GTS_PDFA1'] OutputIntent subtype.
   * @param {Uint8Array|ArrayBuffer|string} [options.outputIntent.destOutputProfile] ICC output profile data (raw
   *   bytes as Uint8Array/ArrayBuffer, or a "binary string" of byte values). If omitted, or if the supplied data
   *   does not look like a valid ICC profile (missing the 'acsp' signature), a bundled default sRGB ICC profile
   *   is embedded instead so the PDF/A-3 OutputIntent always references a real destination profile, as required
   *   by ISO 19005-3 clause 6.2.4.3 for DeviceRGB/DeviceGray content.
   * @param {number} [options.outputIntent.n] Number of colour components for /N. Auto-detected from the ICC
   *   profile's data colour space signature when omitted (RGB=3, GRAY=1, CMYK=4).
   * @param {Object} [options.facturx] Factur-X configuration options.
   * @param {Object} [options.zugferd] ZUGFeRD configuration options.
   * @param {Array} [options.schemas] Custom extension schemas.
   * @param {string} [options.customXmp] Custom raw XMP XML snippet.
   * @returns {jsPDF} jsPDF instance.
   * @example
   * var doc = new jsPDF();
   * doc.enablePdfA3({
   *   conformance: 'B',
   *   title: 'Invoice #1234',
   *   author: 'Acme Corp'
   * });
   */
  jsPDFAPI.enablePdfA3 = jsPDFAPI.setPdfA3 = jsPDFAPI.setPdfA = function(
    options
  ) {
    var enabled = true;
    var opts = options;
    if (typeof options === "boolean") {
      enabled = options;
      opts = arguments[1] || {};
    } else if (typeof options === "string") {
      opts = { conformance: options };
    } else {
      opts = options || {};
    }

    var state = getPdfAState(this);
    state.enabled = enabled;
    state.options = Object.assign({}, state.options, opts);

    if (!enabled) {
      return this;
    }

    if (typeof this.internal.setPDFVersion === "function") {
      this.internal.setPDFVersion("1.7");
    } else if (typeof this.setPdfVersion === "function") {
      this.setPdfVersion("1.7");
    }

    // Sync metadata properties
    var propsToSync = {};
    if (opts.title) propsToSync.title = opts.title;
    if (opts.author || opts.creator) {
      propsToSync.author = opts.author || opts.creator;
    }
    if (opts.subject || opts.description) {
      propsToSync.subject = opts.subject || opts.description;
    }
    if (opts.keywords) propsToSync.keywords = opts.keywords;
    if (opts.creator) propsToSync.creator = opts.creator;
    if (
      Object.keys(propsToSync).length > 0 &&
      typeof this.setDocumentProperties === "function"
    ) {
      this.setDocumentProperties(propsToSync);
    }
    if (opts.creationDate && typeof this.setCreationDate === "function") {
      this.setCreationDate(opts.creationDate);
    }

    subscribePdfAEvents.call(this);
    return this;
  };

  /**
   * Check whether PDF/A-3 mode is enabled on this jsPDF instance.
   *
   * @name isPdfA3Enabled
   * @function
   * @public
   * @returns {boolean} True if PDF/A-3 is enabled.
   */
  jsPDFAPI.isPdfA3Enabled = function() {
    var state = getPdfAState(this);
    return Boolean(state.enabled);
  };

  /**
   * Get the current PDF/A configuration options.
   *
   * @name getPdfA3Options
   * @function
   * @public
   * @returns {Object} PDF/A configuration options.
   */
  jsPDFAPI.getPdfA3Options = jsPDFAPI.getPdfAOptions = function() {
    var state = getPdfAState(this);
    return Object.assign({}, state.options);
  };

  /**
   * Embeds an arbitrary file as an Associated File (AF) conforming to PDF/A-3 (ISO 19005-3).
   *
   * @name addFileAttachment
   * @function
   * @public
   * @param {Object} options File attachment options.
   * @param {string} options.filename Filename for the attachment (e.g. 'ubl-invoice.xml').
   * @param {string|Uint8Array|ArrayBuffer|Array} options.content File content.
   * @param {string} [options.mimeType] MIME type (e.g. 'application/xml'). Auto-detected from filename extension if omitted.
   * @param {string} [options.contentType] Alias for options.mimeType.
   * @param {string} [options.description] Optional description of the file.
   * @param {string} [options.relationship='Alternative'] AFRelationship value ('Alternative', 'Data', 'Source', 'Supplement', 'Unspecified').
   * @param {string} [options.afRelationship] Alias for options.relationship.
   * @param {Date|string} [options.creationDate] File creation date.
   * @param {Date|string} [options.modDate] File modification date.
   * @param {string} [options.unicodeFilename] Optional Unicode filename if different from options.filename.
   * @returns {jsPDF} jsPDF instance.
   * @example
   * doc.addFileAttachment({
   *   filename: 'attachment.xml',
   *   content: '<data>...</data>',
   *   mimeType: 'application/xml',
   *   description: 'Data file',
   *   relationship: 'Data'
   * });
   */
  jsPDFAPI.addFileAttachment = jsPDFAPI.attachFile = jsPDFAPI.embedFile = function(
    options
  ) {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options passed to jsPDF.addFileAttachment");
    }
    if (!options.filename || typeof options.filename !== "string") {
      throw new Error("filename is required for jsPDF.addFileAttachment");
    }
    if (typeof options.content === "undefined" || options.content === null) {
      throw new Error("content is required for jsPDF.addFileAttachment");
    }

    var state = getPdfAState(this);
    var mimeType =
      options.mimeType ||
      options.contentType ||
      guessMimeType(options.filename);
    var relationship =
      options.relationship || options.afRelationship || "Alternative";

    var attachment = {
      filename: options.filename,
      unicodeFilename: options.unicodeFilename || options.filename,
      content: options.content,
      mimeType: mimeType,
      description: options.description || "",
      relationship: normalizeAfRelationship(relationship),
      creationDate: options.creationDate || new Date(),
      modDate:
        options.modDate ||
        options.modificationDate ||
        options.creationDate ||
        new Date(),
      streamObjId: null,
      filespecObjId: null
    };

    state.attachments.push(attachment);
    subscribePdfAEvents.call(this);

    return this;
  };

  /**
   * High-level helper API for electronic invoice workflows (UBL XML, Factur-X, ZUGFeRD, XRechnung, PEPPOL).
   * Automatically enables PDF/A-3 mode (PDF/A-3b) if not already enabled and attaches the UBL XML invoice
   * with sensible defaults.
   *
   * @name attachUblXml
   * @function
   * @public
   * @param {string|Uint8Array|ArrayBuffer} xmlContent The UBL XML invoice document content.
   * @param {Object} [options] Optional configuration options.
   * @param {string} [options.filename='factur-x.xml'|'zugferd-invoice.xml'|'ubl-invoice.xml'] Attachment filename.
   * @param {string} [options.mimeType='application/xml'] MIME type of the invoice file.
   * @param {string} [options.description] Description of the attached invoice.
   * @param {string} [options.relationship='Alternative'] AF relationship ('Alternative', 'Data', 'Source', 'Supplement').
   * @param {boolean} [options.enablePdfA3=true] Whether to automatically enable PDF/A-3 mode.
   * @param {string} [options.conformance='B'] PDF/A-3 conformance level ('B', 'A', 'U').
   * @param {string} [options.title] Document title.
   * @param {string} [options.author] Document author.
   * @param {string} [options.subject] Document subject.
   * @param {string} [options.keywords] Document keywords.
   * @param {Date|string} [options.creationDate] Document and file creation date.
   * @param {Date|string} [options.modDate] Document and file modification date.
   * @param {Object} [options.facturx] Optional Factur-X configuration.
   * @param {Object} [options.zugferd] Optional ZUGFeRD configuration.
   * @returns {jsPDF} jsPDF instance.
   * @example
   * var doc = new jsPDF();
   * doc.text('Invoice #1001', 10, 10);
   * doc.attachUblXml(ublXmlString, {
   *   filename: 'ubl-invoice.xml',
   *   title: 'Invoice #1001'
   * });
   * doc.save('invoice.pdf');
   */
  jsPDFAPI.attachUblXml = jsPDFAPI.attachInvoiceXml = function(
    xmlContent,
    options
  ) {
    if (typeof xmlContent === "undefined" || xmlContent === null) {
      throw new Error("xmlContent is required for jsPDF.attachUblXml");
    }
    options = options || {};

    var isZugferd =
      options.preset === "zugferd" ||
      options.type === "zugferd" ||
      !!options.zugferd;
    var isFacturX =
      options.preset === "facturx" ||
      options.preset === "factur-x" ||
      options.type === "facturx" ||
      options.type === "factur-x" ||
      !!options.facturx;

    var defaultFilename = isZugferd
      ? "zugferd-invoice.xml"
      : isFacturX || (!options.filename && !isZugferd)
      ? "factur-x.xml"
      : "ubl-invoice.xml";

    var filename = options.filename || defaultFilename;
    var mimeType =
      options.mimeType || options.contentType || "application/xml";
    var description =
      options.description ||
      (isZugferd
        ? "ZUGFeRD electronic invoice"
        : isFacturX || filename === "factur-x.xml"
        ? "Factur-X electronic invoice"
        : "UBL XML Invoice");
    var relationship =
      options.relationship || options.afRelationship || "Alternative";
    var enablePdfA3 = options.enablePdfA3 !== false;

    var pdfaOpts = Object.assign({}, options, {
      version: options.version || "3",
      conformance: options.conformance || "B"
    });

    if (isZugferd) {
      pdfaOpts.zugferd = Object.assign(
        {
          documentFileName: filename,
          documentType: options.documentType || "INVOICE",
          version: options.version || "2.0",
          conformanceLevel:
            options.conformanceLevel || options.profile || "COMFORT",
          urn: options.urn
        },
        options.zugferd || {}
      );
    } else {
      // Default to Factur-X extension schema for electronic invoices (e.g. UBL / CII)
      pdfaOpts.facturx = Object.assign(
        {
          documentFileName: filename,
          documentType: options.documentType || "INVOICE",
          version: options.version || "1.0",
          conformanceLevel:
            options.conformanceLevel || options.profile || "EN 16931",
          urn: options.urn
        },
        options.facturx || {}
      );
    }

    if (enablePdfA3) {
      this.enablePdfA3(pdfaOpts);
    }

    this.addFileAttachment({
      filename: filename,
      unicodeFilename: options.unicodeFilename || filename,
      content: xmlContent,
      mimeType: mimeType,
      description: description,
      relationship: relationship,
      creationDate: options.creationDate,
      modDate: options.modDate || options.modificationDate
    });

    return this;
  };

  /**
   * Returns list of currently attached files on this jsPDF instance.
   *
   * @name getFileAttachments
   * @function
   * @public
   * @returns {Array} Array of file attachment objects.
   */
  jsPDFAPI.getFileAttachments = jsPDFAPI.getAttachments = function() {
    var state = getPdfAState(this);
    return state.attachments.map(function(att) {
      return {
        filename: att.filename,
        unicodeFilename: att.unicodeFilename,
        mimeType: att.mimeType,
        description: att.description,
        relationship: att.relationship,
        creationDate: att.creationDate,
        modDate: att.modDate
      };
    });
  };
})(jsPDF.API);
