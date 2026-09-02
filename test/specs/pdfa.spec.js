/* global describe, it, expect, beforeAll, loadGlobals, jsPDF */

describe("Module: PDF/A-3 and Associated Files", () => {
  beforeAll(loadGlobals);

  it("should enable PDF/A-3 via constructor options and set PDF version 1.7", () => {
    const doc = new jsPDF({
      pdfa: true
    });
    expect(doc.isPdfA3Enabled()).toBe(true);
    expect(doc.getPdfVersion()).toBe("1.7");

    const output = doc.output();
    expect(output.startsWith("%PDF-1.7")).toBe(true);
    expect(output).toContain("/Type /Catalog");
    expect(output).toContain("/OutputIntents [");
    expect(output).toContain("/GTS_PDFA1");
    expect(output).toContain("<pdfaid:part>3</pdfaid:part>");
    expect(output).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
  });

  it("should enable PDF/A-3 via enablePdfA3() API with custom conformance", () => {
    const doc = new jsPDF();
    expect(doc.isPdfA3Enabled()).toBe(false);

    doc.enablePdfA3({
      conformance: "A",
      title: "Invoice 12345",
      author: "Acme Corp",
      creator: "Billing System",
      keywords: "invoice, ubl, pdfa"
    });

    expect(doc.isPdfA3Enabled()).toBe(true);
    expect(doc.getPdfA3Options().conformance).toBe("A");

    const output = doc.output();
    expect(output.startsWith("%PDF-1.7")).toBe(true);
    expect(output).toContain("<pdfaid:part>3</pdfaid:part>");
    expect(output).toContain("<pdfaid:conformance>A</pdfaid:conformance>");
    expect(output).toContain("<dc:title>");
    expect(output).toContain("Invoice 12345");
    expect(output).toContain("<dc:creator>");
    expect(output).toContain("Acme Corp");
    expect(output).toContain("<pdf:Keywords>invoice, ubl, pdfa</pdf:Keywords>");
  });

  it("should support setPdfA and alias methods", () => {
    const doc = new jsPDF();
    doc.setPdfA(true, { conformance: "U" });
    expect(doc.isPdfA3Enabled()).toBe(true);
    expect(doc.getPdfA3Options().conformance).toBe("U");

    const output = doc.output();
    expect(output).toContain("<pdfaid:conformance>U</pdfaid:conformance>");
  });

  it("should emit valid default OutputIntent and custom OutputIntent options", () => {
    const doc = new jsPDF();
    doc.enablePdfA3({
      outputIntent: {
        identifier: "sRGB IEC61966-2.1",
        info: "sRGB v4",
        registryName: "http://www.color.org",
        condition: "sRGB"
      }
    });

    const output = doc.output();
    expect(output).toContain("/Type /OutputIntent");
    expect(output).toContain("/S /GTS_PDFA1");
    expect(output).toContain("/OutputConditionIdentifier (sRGB IEC61966-2.1)");
    expect(output).toContain("/Info (sRGB v4)");
    expect(output).toContain("/RegistryName (http://www.color.org)");
    expect(output).toContain("/OutputCondition (sRGB)");
  });

  it("should embed a bundled default sRGB ICC destination profile when none is supplied, to remain PDF/A-3 validator compliant for DeviceRGB/DeviceGray", () => {
    const doc = new jsPDF({ pdfa: true });
    doc.setFillColor(255, 0, 0);
    doc.rect(10, 10, 20, 20, "F");
    doc.setTextColor(0, 0, 0);
    doc.text("Invoice", 10, 40);

    const output = doc.output();
    // A real destination profile stream must always be referenced and embedded,
    // per ISO 19005-3 clause 6.2.4.3, even if the caller did not provide one.
    expect(output).toContain("/DestOutputProfile");
    expect(output).toContain("/N 3");
    expect(output).toMatch(/\/N 3\s*\/Length \d+/);
  });

  it("should honor a valid caller-supplied ICC destOutputProfile and auto-detect /N from its colour space", () => {
    const doc = new jsPDF();
    // Minimal well-formed ICC profile header stub with a GRAY data colour space signature
    // at byte offset 16 and the required 'acsp' file signature at byte offset 36.
    const iccBytes = new Uint8Array(132);
    "GRAY".split("").forEach((ch, i) => (iccBytes[16 + i] = ch.charCodeAt(0)));
    "acsp".split("").forEach((ch, i) => (iccBytes[36 + i] = ch.charCodeAt(0)));

    doc.enablePdfA3({
      outputIntent: {
        destOutputProfile: iccBytes
      }
    });

    const output = doc.output();
    expect(output).toContain("/DestOutputProfile");
    expect(output).toContain("/N 1");
    expect(output).toContain("/Length " + iccBytes.length);
  });

  it("should fall back to the bundled default ICC profile when the supplied destOutputProfile is not a valid ICC profile", () => {
    const doc = new jsPDF();
    const invalidIccBytes = new Uint8Array(200).fill(1); // no 'acsp' signature present

    doc.enablePdfA3({
      outputIntent: {
        destOutputProfile: invalidIccBytes
      }
    });

    const output = doc.output();
    // Should still embed a valid destination profile (the bundled default), not the garbage bytes.
    expect(output).toContain("/DestOutputProfile");
    expect(output).toContain("/N 3");
    expect(output).not.toContain("/Length 200");
  });

  it("should let the caller explicitly override /N for the destination profile", () => {
    const doc = new jsPDF();
    const iccBytes = new Uint8Array(132);
    "CMYK".split("").forEach((ch, i) => (iccBytes[16 + i] = ch.charCodeAt(0)));
    "acsp".split("").forEach((ch, i) => (iccBytes[36 + i] = ch.charCodeAt(0)));

    doc.enablePdfA3({
      outputIntent: {
        destOutputProfile: iccBytes,
        n: 4
      }
    });

    const output = doc.output();
    expect(output).toContain("/N 4");
  });

  it("should attach arbitrary string files with AFRelationship, Filespec, and Names tree", () => {
    const doc = new jsPDF({ pdfa: true });
    const content = '{"sample": "data", "id": 100}';
    
    doc.addFileAttachment({
      filename: "data.json",
      content: content,
      mimeType: "application/json",
      description: "JSON data source",
      relationship: "Data",
      creationDate: new Date("2026-01-01T12:00:00Z"),
      modificationDate: new Date("2026-01-01T12:00:00Z")
    });

    expect(doc.getFileAttachments().length).toBe(1);

    const output = doc.output();
    // Verify file stream
    expect(output).toContain("/Type /EmbeddedFile");
    expect(output).toContain("/Subtype /application#2Fjson");
    expect(output).toContain("/Size " + content.length);

    // Verify filespec
    expect(output).toContain("/Type /Filespec");
    expect(output).toContain("/F (data.json)");
    expect(output).toContain("/UF (data.json)");
    expect(output).toContain("/AFRelationship /Data");
    expect(output).toContain("/Desc (JSON data source)");

    // Verify Catalog entries
    expect(output).toContain("/AF [");
    expect(output).toContain("/Names << /EmbeddedFiles");
    expect(output).toContain("(data.json)");
  });

  it("should attach binary Uint8Array files", () => {
    const doc = new jsPDF({ pdfa: true });
    const binaryData = new Uint8Array([0x3c, 0x78, 0x6d, 0x6c, 0x20, 0x76, 0x65, 0x72]); // "<xml ver"
    
    doc.attachFile({
      filename: "sample.xml",
      content: binaryData,
      mimeType: "text/xml",
      relationship: "Source"
    });

    const output = doc.output();
    expect(output).toContain("/Type /EmbeddedFile");
    expect(output).toContain("/Subtype /text#2Fxml");
    expect(output).toContain("/Size 8");
    expect(output).toContain("/AFRelationship /Source");
  });

  it("should sort multiple attachments lexicographically in Names tree", () => {
    const doc = new jsPDF({ pdfa: true });
    doc.addFileAttachment({
      filename: "zebra.txt",
      content: "Zebra text"
    });
    doc.addFileAttachment({
      filename: "alpha.txt",
      content: "Alpha text"
    });
    doc.addFileAttachment({
      filename: "factur-x.xml",
      content: "<xml>Factur-X</xml>"
    });

    const output = doc.output();
    const namesMatch = output.match(/\/Names\s*\[\s*([\s\S]*?)\s*\]/);
    expect(namesMatch).not.toBeNull();
    const namesSection = namesMatch[1];
    const alphaIndex = namesSection.indexOf("(alpha.txt)");
    const facturIndex = namesSection.indexOf("(factur-x.xml)");
    const zebraIndex = namesSection.indexOf("(zebra.txt)");

    expect(alphaIndex).toBeGreaterThan(-1);
    expect(facturIndex).toBeGreaterThan(alphaIndex);
    expect(zebraIndex).toBeGreaterThan(facturIndex);
  });

  it("should attach UBL XML invoice with attachUblXml helper and default Factur-X metadata", () => {
    const doc = new jsPDF();
    const ublXml = '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>INV-2026-001</ID></Invoice>';

    doc.attachUblXml(ublXml);

    expect(doc.isPdfA3Enabled()).toBe(true);
    const attachments = doc.getFileAttachments();
    expect(attachments.length).toBe(1);
    expect(attachments[0].filename).toBe("factur-x.xml");
    expect(attachments[0].mimeType).toBe("application/xml");
    expect(attachments[0].relationship).toBe("Alternative");

    const output = doc.output();
    expect(output.startsWith("%PDF-1.7")).toBe(true);
    expect(output).toContain("/Type /EmbeddedFile");
    expect(output).toContain("/Subtype /application#2Fxml");
    expect(output).toContain("/AFRelationship /Alternative");
    expect(output).toContain("/F (factur-x.xml)");

    // Factur-X XMP extension schema
    expect(output).toContain("Factur-X PDFA Extension Schema");
    expect(output).toContain("urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#");
    expect(output).toContain("<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>");
    expect(output).toContain("<fx:DocumentType>INVOICE</fx:DocumentType>");
    expect(output).toContain("<fx:Version>1.0</fx:Version>");
    expect(output).toContain("<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>");
  });

  it("should attach UBL XML with custom filename and options", () => {
    const doc = new jsPDF();
    const ublXml = '<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID>INV-999</cbc:ID></ubl:Invoice>';

    doc.attachUblXml(ublXml, {
      filename: "ubl-invoice.xml",
      profile: "EXTENDED",
      version: "2.1",
      description: "UBL 2.1 Invoice XML attachment",
      relationship: "Data"
    });

    const output = doc.output();
    expect(output).toContain("/F (ubl-invoice.xml)");
    expect(output).toContain("/AFRelationship /Data");
    expect(output).toContain("/Desc (UBL 2.1 Invoice XML attachment)");
    expect(output).toContain("<fx:DocumentFileName>ubl-invoice.xml</fx:DocumentFileName>");
    expect(output).toContain("<fx:Version>2.1</fx:Version>");
    expect(output).toContain("<fx:ConformanceLevel>EXTENDED</fx:ConformanceLevel>");
  });

  it("should support attachInvoiceXml with ZUGFeRD preset", () => {
    const doc = new jsPDF();
    const zugferdXml = '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"></rsm:CrossIndustryInvoice>';

    doc.attachInvoiceXml(zugferdXml, {
      preset: "zugferd",
      conformanceLevel: "COMFORT"
    });

    const attachments = doc.getFileAttachments();
    expect(attachments.length).toBe(1);
    expect(attachments[0].filename).toBe("zugferd-invoice.xml");

    const output = doc.output();
    expect(output).toContain("/F (zugferd-invoice.xml)");
    expect(output).toContain("ZUGFeRD PDFA Extension Schema");
    expect(output).toContain("urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#");
    expect(output).toContain("<zf:DocumentFileName>zugferd-invoice.xml</zf:DocumentFileName>");
    expect(output).toContain("<zf:ConformanceLevel>COMFORT</zf:ConformanceLevel>");
  });

  it("should support custom XMP extension schemas and raw XMP injection", () => {
    const doc = new jsPDF();
    doc.enablePdfA3({
      schemas: [
        {
          schema: "Custom Order Schema",
          prefix: "ord",
          namespaceURI: "http://example.com/order/1.0/",
          properties: [
            {
              name: "OrderNumber",
              valueType: "Text",
              description: "Customer purchase order reference",
              value: "PO-2026-99"
            }
          ]
        }
      ],
      customXmp: "<custom:Tag>CustomValue</custom:Tag>"
    });

    const output = doc.output();
    expect(output).toContain("<pdfaSchema:schema>Custom Order Schema</pdfaSchema:schema>");
    expect(output).toContain("<pdfaSchema:prefix>ord</pdfaSchema:prefix>");
    expect(output).toContain("<ord:OrderNumber>PO-2026-99</ord:OrderNumber>");
    expect(output).toContain("<custom:Tag>CustomValue</custom:Tag>");
  });

  it("should format dates in PDF date format (D:YYYYMMDDHHmmSSOHH'mm') and ISO in XMP", () => {
    const fixedDate = new Date("2026-03-15T09:30:00Z");
    const doc = new jsPDF({
      pdfa: true,
      creationDate: fixedDate,
      modDate: fixedDate
    });

    doc.attachUblXml("<Invoice/>", {
      creationDate: fixedDate,
      modificationDate: fixedDate
    });

    const output = doc.output();
    expect(output).toContain("20260315");
    expect(output).toContain("2026-03-15T09:30:00Z");
  });

  it("should not affect non-PDF/A documents when PDF/A-3 is not enabled", () => {
    const doc = new jsPDF();
    doc.text("Standard PDF document", 10, 10);
    const output = doc.output();

    expect(output.startsWith("%PDF-1.3")).toBe(true);
    expect(output).not.toContain("pdfaid:part");
    expect(output).not.toContain("/OutputIntents");
    expect(output).not.toContain("/AF [");
  });

  it("should support embedFile alias and return doc instance for chaining", () => {
    const doc = new jsPDF();
    const result = doc
      .enablePdfA3()
      .embedFile({ filename: "notes.txt", content: "hello world" })
      .text("Hello PDF/A-3", 10, 10);

    expect(result).toBe(doc);
    expect(doc.getFileAttachments().length).toBe(1);
    expect(doc.output()).toContain("/F (notes.txt)");
  });
});
