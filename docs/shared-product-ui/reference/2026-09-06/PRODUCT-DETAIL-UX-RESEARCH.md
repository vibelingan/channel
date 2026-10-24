# Product-detail UX research: variants, specifications, and quote flow

Date: 2026-08-31  
Scope: research and recommendations only; no implementation changes  
Target: Channel's B2B/OEM catalog product-detail experience after Dianxiaomi/Lazada Excel import

## Decision summary

1. **Do not show every SKU as a large card by default.** Show one currently selected variant and one selector group per option dimension (for example, `Color` and `Storage Capacity`). Update the main image, selected thumbnail, SKU, availability, and other variant-specific fields together.
2. **Do not make the gallery the only variant selector.** A thumbnail may select a variant only when the imported data explicitly maps that image to one color or SKU. Shared lifestyle/detail images must remain ordinary gallery images and must not guess a SKU.
3. **Keep an optional compact SKU view for procurement users.** A collapsed `View all 4 SKUs` table can preserve auditability without making four inventory cards the main shopping interaction.
4. **Split imported description content into structured specifications and prose.** Preserve the source text exactly, extract recognized key/value pairs conservatively, and render them in grouped rows. Never discard unparsed text.
5. **A Request a Quote CTA is appropriate for a B2B/OEM catalog only when it is contextual.** The form must receive the product, selected SKU/options, desired quantity, and relevant customization context. A jump to a generic OEM form that loses the selection is not a sound end-to-end product flow.

## Evidence and access limits

| Source | What was observed or documented | Access caveat |
| --- | --- | --- |
| [Apple refurbished iPhone 16 Pro product page](https://www.apple.com/shop/product/fymu3ll/a/refurbished-iphone-16-pro-1tb-natural-titanium-unlocked) | No login was needed. The page presents Storage and Color as explicit controls. In a browser interaction check, choosing `Black Titanium` changed the selected color heading and the main/gallery image alternative text from Natural Titanium to Black Titanium. Product information, features, and technical specifications are separate expandable sections. | This particular refurbished configuration can change or disappear as inventory changes. The interaction was observed on 2026-08-31. |
| [Shopify official variant theme guidance](https://shopify.dev/docs/storefronts/themes/product-merchandising/variants) | A product is selected by option combinations. Shopify explicitly requires product media and price to update for the selected variant and supports direct links to a selected variant. | This is first-party implementation guidance rather than one merchant's storefront. |
| [Shopify official variant-image guidance](https://help.shopify.com/en/manual/products/product-media/add-images-variants) | A variant can have an assigned image; when the variant is selected, that image becomes its preview. Additional related images can remain in the product gallery. | Shopify's basic variant model supports one directly assigned image per variant; richer grouped media requires additional product modeling. |
| [Alibaba.com live OEM headphone product](https://www.alibaba.com/product-detail/wholesale-Silent-Disco-Headphone-F49-hifi_1600277766860.html) | The live page separates color/connector choices, quantity-tier pricing, key attributes, lead time, customization options, supplier description, and `Send inquiry`. | Availability and supplier content can change. No inquiry was submitted. |
| [Alibaba.com live headphone product with structured attributes](https://www.alibaba.com/product-detail/Starsky-DG08-Wireless-IPX6-Sports-Headset_1601101945170.html) | The live page separates variant choices from structured key attributes, packaging, lead time, customization, shipping, and the supplier description. | Availability and supplier content can change. |
| [Made-in-China live B2B headphone product](https://sys2026.en.made-in-china.com/product/GRKYHQpUOohC/China-Earphones-Over-Ear-Bluetooth-Headphones-Wireless-for-Students.html) | The product exposes `Buy Now`, `Send Inquiry`, sample ordering, concise Product Details, a longer description, and an inquiry form addressed to the supplier. | The listing can change; no inquiry was submitted. |
| [Grainger live product detail](https://www.grainger.com/product/LUMINAIRE-LED-Vandal-and-Ligature-Resistant-61HR50) | Anonymous users can see item/manufacturer identifiers and a long Product Details area as labeled attribute/value rows, with explanations attached to technical attributes where useful. | Account-specific pricing and account functions remain gated. |
| [Taobao official SKU/sales-attribute guidance](https://developer.alibaba.com/docs/doc.htm?articleId=108955&docType=1&treeId=796) | Sales attributes such as color and size form SKUs; an uploaded sales-attribute image can represent a color value. | This is first-party platform documentation, not a directly observed anonymous Tmall product interaction. |
| [Taobao official item/SKU schema](https://developer.alibaba.com/docs/api.htm?apiId=42954) | The schema separates product-level data, property images, and each SKU's sales-property combination, quantity, and price. | API documentation; fields and permissions can evolve. |
| [JD official product-detail schema](https://opendoc.jd.com/iopv2/iopv2/%E5%95%86%E5%93%81/%E6%9F%A5%E8%AF%A2%E5%95%86%E5%93%81%E8%AF%A6%E6%83%85.html) | JD distinguishes `saleAttr` choices (such as color/size), SPU identity, structured parameter details, and large rich-detail fields. | Direct anonymous browser automation of current JD item pages was redirected to JD's frequency/risk-control pages. The public indexed page was readable, but click-level selector behavior was not claimed as verified. |
| Tmall live item | Direct browser access redirected to Taobao login. | No unauthenticated click-level Tmall observation is claimed. |

## 1. Recommended variant interaction

### Primary layout

The product page should have one selected-variant state:

```text
Product gallery                 Product title
                                Selected: Black / 12GB+256GB
                                Color: [Black] [White] [Blue] [Powder]
                                Storage: [12GB+256GB]
                                SKU: 5924621964128
                                Availability: 9 available
                                Quantity: [-] 1 [+]
                                [Request a quote for this variant]

                                4 variants  [View all SKUs]
```

The selector should be built from dimensions, not from a flat list of full SKU records:

- Group one: `Color Family` with image swatches when reliable color images exist.
- Group two: `Storage Capacity` with text buttons.
- Other imported dimensions become additional groups only when they actually distinguish SKUs.
- Selected values should be visible in text, not communicated only by a colored border.
- Impossible or unavailable combinations should be disabled and labeled, not left clickable and allowed to fail later.

### Image and variant linkage

Use an explicit mapping, not filename order or visual similarity:

```text
product image -> optional option value (for example Color=Black)
variant       -> exact option combination + optional featured image
```

Behavior:

1. Selecting a complete variant updates:
   - featured/main image;
   - highlighted thumbnail;
   - selected option labels;
   - SKU;
   - availability;
   - any variant-dependent quote information.
2. Clicking a thumbnail that has an unambiguous `variantId` selects that variant.
3. Clicking an image mapped only to `Color=Black` selects the color but retains or asks for the remaining dimensions, such as Storage.
4. Clicking a shared product, packaging, lifestyle, or detail image changes only the gallery image; it must not silently change the SKU.
5. If several variants reuse the same image, the image cannot determine the exact SKU. The user must finish selection through labeled controls.

This direction matches Apple's observed color-to-gallery update, Shopify's required selected-variant/media update, and the SKU/property-image separation in Alibaba/Taobao's official data model.

### Keep the all-SKU information, but subordinate it

The current four large variant cards are useful as data evidence but weak as the primary customer experience. Retain an optional collapsed table for wholesale users:

| SKU | Color | Storage | Available |
| --- | --- | --- | --- |
| 5924621964128 | Black | 12GB+256GB | 9 |

The table can be searchable for products with many variants, but it should not compete with the selected-variant panel above the fold.

### Accessibility and URL state

- Implement each option group as real radios or accessible toggle buttons with a visible group label.
- Expose selected and unavailable states programmatically (`checked`, `aria-pressed`, `disabled`).
- Give image swatches text alternatives such as `Black`.
- Keep keyboard focus on the selected control when the page updates.
- Announce changed SKU/availability through a restrained live region.
- Deep-link the selected variant in the URL so a customer can share the exact configuration and browser Back restores it.

## 2. Importing and displaying a readable description

### Separate the data by meaning

The screenshot's long block contains a short product narrative mixed with attributes such as operating system, chipset, Bluetooth version, camera resolution, shell material, and certificate number. These are not one description concept.

Recommended stored shape:

```text
rawDescription          exact original source value, never rewritten
descriptionParagraphs   prose that was not classified as a specification
highlights[]            short customer-facing benefits, only when sourced
specifications[]        { section, originalLabel, normalizedKey, value, sourceOffset }
variantOptions{}        color/capacity/etc. from dedicated SKU fields
certifications[]        certificate type/number when confidently recognized
parseWarnings[]         ambiguous or unparsed fragments
```

The source's dedicated columns and SKU fields must take precedence over reparsing the description. For example, `Color Family` and `Storage Capacity` already belong to the selected variant and should not be duplicated as parent-level narrative text.

### Conservative extraction algorithm

1. Preserve the raw cell before any transformation.
2. Normalize whitespace and line endings, but retain a source-to-output trace.
3. Prefer explicit source delimiters such as line breaks, HTML blocks, or known column boundaries.
4. Recognize a key only when it matches a controlled/learned product-attribute dictionary or a repeated source pattern.
5. Treat the next recognized key boundary as the end of the current value. **Do not split on every colon.** URLs, ratios, times, model names, and free prose can contain colons.
6. Normalize equivalent keys for grouping (for example `Bluetooth version` and `Bluetooth Version`) while preserving the original label for audit/display.
7. Validate high-risk values where possible: certificate numbers, dimensions/units, storage, battery capacity, and URLs.
8. Send every unmatched fragment to `descriptionParagraphs` or `Additional details`; never silently drop it.
9. Record warnings for duplicate keys with conflicting values rather than choosing one without evidence.

This can be deterministic and does not require an AI rewrite. AI-assisted classification, if ever added, should be reviewable and must not invent missing attributes.

### Rendering structure

Above the fold, show a small `Key specifications` group with the 6-10 fields most useful for the category. Below it, use sections or accordions such as:

- General: brand, model, operating system
- Performance: chipset, memory, storage
- Connectivity: Bluetooth, network, ports
- Camera/display or category-specific group
- Materials and dimensions
- Compliance and certifications
- Package contents
- Product description: remaining prose in paragraphs/bullets
- Additional source details: unmatched text, if any

Use a responsive definition list or two-column table (`Label` / `Value`) on desktop and stacked rows on mobile. Alibaba.com, Grainger, Apple, and JD's official product model all separate structured attributes from long-form product content.

## 3. Is the Request a Quote redirect logically sound?

### What the benchmark says

- JD's consumer retail page uses purchase actions such as Add to Cart / Buy Now, not an RFQ flow.
- Alibaba.com and Made-in-China put `Send inquiry`/supplier contact beside B2B product, quantity, MOQ, customization, and supplier context.
- Alibaba's own supplier guidance tells custom-product buyers to contact a supplier with detailed specifications and request a sample: [Alibaba Supplier Directory](https://suppliers.alibaba.com/).
- Shopify's product-form model combines variant selection with the action form and supports carrying additional product-specific properties: [Shopify product template guidance](https://shopify.dev/storefronts/themes/architecture/templates/product).

### Assessment for Channel

**The CTA concept is sound. The current destination is sound only if it preserves context.** Channel is presenting an OEM/wholesale catalog rather than a fixed-price retail checkout, so a quote is a sensible primary conversion. But the action must mean `request a quote for what I just selected`, not `leave this product and start a generic OEM brief from zero`.

Minimum quote payload:

- parent product ID and title;
- selected variant ID and SKU;
- selected option values;
- requested quantity (or a quantity field on the quote form);
- source page URL;
- image/thumbnail for confirmation;
- optional customization needs: logo, packaging, material, color, certification, target market;
- optional deadline/destination.

The quote page or modal should display a read-only summary with an `Edit selection` link. If a required variant dimension is not selected, the CTA should first focus that missing choice rather than submit an ambiguous request.

Recommended labels:

- selected: `Request a quote for this variant`;
- no complete selection: `Select options to request a quote`;
- secondary OEM path: `Ask about customization`.

Whether the existing `/oem` redirect is long-standing legacy behavior cannot be determined from marketplace research. That question requires repository route and Git-history inspection. Even if it is old behavior, age alone does not validate the current flow; the decisive test is whether product/variant context arrives intact and is shown to the user.

## Acceptance checks for a later implementation

1. Selecting each color updates the intended featured image and text label.
2. Selecting a complete option combination updates the exact imported SKU and availability.
3. A shared gallery image does not silently switch variants.
4. An unavailable combination is disabled and explained.
5. A deep link restores the exact selected variant after reload.
6. Keyboard and screen-reader users can identify and change every option.
7. The default view shows one selected variant; the full SKU table is collapsed.
8. Structured specification values match the original Excel cell byte-for-byte after normalization rules are accounted for.
9. Ambiguous description fragments remain visible and create parse warnings rather than disappearing.
10. Request a Quote receives and displays parent product, selected SKU/options, and quantity.
11. Returning from the quote form restores the same product/variant state.
12. Mobile layout keeps selection, availability, and CTA understandable without exposing a long wall of SKU cards or prose.

## Strongest caveat

Taobao/Tmall and JD apply login/risk-control restrictions to anonymous automated access. This research therefore combines limited first-party live-page observations with their official product/SKU schemas and with independently accessible Apple, Alibaba.com, Made-in-China, Shopify, and Grainger evidence. It does **not** claim a fully automated, click-by-click reproduction of current Taobao, Tmall, or JD product-detail behavior.
