---
locale: en-US

meta:
  title: OEM Development
  description: >-
    One-stop OEM development service — from product design and mold tooling to
    mass production, quality control, and global logistics.

hero:
  eyebrow: OEM / ODM Development
  heading: One-stop OEM development, from idea to shipment
  subheading: >-
    A single, accountable partner for the entire product journey — design,
    engineering, tooling, sampling, production, and worldwide delivery.
  primaryCta: { label: Submit your project, href: '#submit' }
  secondaryCta: { label: See our process, href: '#process' }

oneStop:
  id: one-stop
  eyebrow: One-stop service
  heading: One-Stop OEM Development Service
  intro: >-
    Everything required to bring a product to market lives under one roof. Each
    capability below is a stage we own end-to-end, so you coordinate with one
    team instead of stitching together a dozen vendors.
  servicesTitle: Eight capabilities, one accountable partner
  services:
    - { icon: design, title: Product Design, desc: 'Concepts, CMF, and design-for-manufacture from day one.' }
    - { icon: id-design, title: ID Design, desc: 'Industrial design that balances aesthetics, ergonomics, and cost.' }
    - { icon: mold, title: Mold Development, desc: 'In-house tooling design and precision mold fabrication.' }
    - { icon: engineer, title: Engineer Support, desc: 'Mechanical, electronic, and firmware engineering on tap.' }
    - { icon: sampling, title: Sampling, desc: 'Rapid prototypes and pre-production samples for sign-off.' }
    - { icon: production, title: Production, desc: 'Scalable assembly lines for pilot runs through mass volume.' }
    - { icon: quality, title: Quality Control, desc: 'Inspection and testing at every stage, not just the end.' }
    - { icon: logistics, title: Global Logistics, desc: 'Export documentation and door-to-door worldwide shipping.' }
  workflowTitle: A clear path from idea to delivery
  workflowIntro: >-
    Every project follows the same proven sequence, so you always know what
    happens next and who owns it.
  workflow:
    - { label: Idea, desc: Requirements & feasibility }
    - { label: Design, desc: ID & engineering }
    - { label: Prototype, desc: Samples & validation }
    - { label: Tooling, desc: Molds & fixtures }
    - { label: Mass Production, desc: Assembly & QC }
    - { label: Shipping, desc: Global delivery }

capabilities:
  id: capabilities
  eyebrow: Development capability
  heading: Our Development Capability
  intro: >-
    Two decades of manufacturing has built a deep, diversified supply chain. We
    develop across six primary product families — and the cross-pollination
    between them is exactly what lets us solve unusual briefs.
  items:
    - { icon: plastic, title: Plastic Products, desc: 'Injection molding, tooling, and finishing for durable plastic parts.' }
    - { icon: electronics, title: Electronics, desc: 'PCBA, embedded firmware, and full electronic device assembly.' }
    - { icon: headphones, title: Headphones, desc: 'Acoustic tuning, wireless audio, and high-volume audio manufacturing.' }
    - { icon: consumer, title: Consumer Goods, desc: 'Everyday products engineered for reliability and shelf appeal.' }
    - { icon: hardware, title: Hardware Products, desc: 'Metal, mechanical, and mixed-material hardware fabrication.' }
    - { icon: promotional, title: Promotional Products, desc: 'Branded merchandise and custom gifts at promotional price points.' }
  note: >-
    A diversified supply chain means flexible sourcing, resilient lead times,
    and one partner who can combine materials and disciplines in a single build.

process:
  id: process
  eyebrow: How we work
  heading: OEM Development Process
  intro: >-
    A standardized, transparent six-step procedure keeps quality consistent and
    timelines predictable — no matter how complex the product.
  steps:
    - { title: Discussing Requirements, desc: 'We align on specifications, target cost, compliance needs, and timeline.' }
    - { title: Concept Designs, desc: 'ID sketches, 3D models, and engineering concepts for your review and sign-off.' }
    - { title: Sample Development, desc: 'Functional prototypes and pre-production samples to validate fit and function.' }
    - { title: Batch Production, desc: 'Tooling release and scaled assembly with documented process controls.' }
    - { title: Quality Check, desc: 'In-line and final inspection against agreed AQL standards before packing.' }
    - { title: Shipping, desc: 'Export paperwork, packaging, and door-to-door global logistics.' }

whyUs:
  id: why-us
  eyebrow: Why choose us
  heading: A partner you can build on
  intro: >-
    Choosing a manufacturer is choosing a long-term partner. Here is what makes
    brands trust us with their products year after year.
  reasons:
    - { icon: experience, stat: '15+', label: Years of Experience, desc: 'Two decades turning concepts into shipped, market-ready products.' }
    - { icon: partners, stat: '100+', label: Supply Chain Partners, desc: 'A vetted network that keeps sourcing flexible and lead times resilient.' }
    - { icon: moq, label: Flexible MOQ, desc: 'Order quantities that scale with your stage, from pilot runs to volume.' }
    - { icon: compliance, label: Global Compliance Support, desc: 'CE, FCC, RoHS, and market-specific certification guidance built in.' }
    - { icon: manager, label: Dedicated Project Manager, desc: 'A single point of contact accountable for your project end-to-end.' }

submit:
  id: submit
  eyebrow: Start your project
  heading: Submit Your Project
  intro: >-
    Tell us about your product and our engineering team will respond with a
    feasibility review and indicative quotation. The more detail you share, the
    faster we can help.
  fields:
    - { name: company, label: Company Name, type: text, required: true, placeholder: Your company }
    - { name: contact, label: Contact Person, type: text, required: true, placeholder: Full name }
    - { name: email, label: Email, type: email, required: true, placeholder: you@company.com }
    - { name: whatsapp, label: WhatsApp, type: tel, placeholder: '+1 555 000 0000' }
    - {
        name: category,
        label: Product Category,
        type: select,
        required: true,
        options:
          [
            Plastic Products,
            Electronics,
            Headphones,
            Consumer Goods,
            Hardware Products,
            Promotional Products,
            Other,
          ],
      }
    - { name: quantity, label: Estimated Quantity, type: number, placeholder: 'e.g. 5000' }
    - {
        name: drawing,
        label: Upload Drawing or Files,
        type: file,
        accept: '.pdf,.zip,.rar,.png,.jpg,.jpeg,.webp,.step,.stp,.igs,.iges,.dwg,.dxf',
        full: true,
        hint: 'PDF, ZIP/RAR, CAD, or images up to 10 MiB. Have several files? Compress them into a single .zip and upload that one file.',
      }
  submitLabel: Submit project
  disclaimer: >-
    Your information is used only to respond to your enquiry and is kept
    confidential.
  successTitle: Thank you — your project has been received.
  successBody: >-
    Our engineering team will review your details and get back to you within one
    business day.

# NOTE (MIU 7 — deferred): the factory VIDEO is deferred until the client's HD
# clip is available. With `src: ''` the poster facility photo renders on its own;
# set `src` to a CloudBase storage/CDN URL to upgrade to an inline video with no
# code change. See docs/oem-refresh/DESIGN.md §10.
factoryVideo:
  src: ''
  poster: /media/factory-oem.webp
  posterWidth: 1228
  posterHeight: 718
  caption: Inside our Dongguan engineering and production facility
---

<!--
en-US content for the OEM Development page. Copy this file to another locale
(e.g. zh-CN.md) and translate the frontmatter to localize the page.
-->
