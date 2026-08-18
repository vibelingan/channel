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
    Bring us a rough idea, sketch, or complete specification. Our product,
    engineering, tooling, production, quality, and logistics teams manage the
    path to a shipment-ready product.
  primaryCta: { label: Submit your project, href: '#submit' }
  secondaryCta: { label: See our process, href: '#process' }

capabilities:
  id: capabilities
  eyebrow: Development capability
  heading: Our Cross-Disciplinary Development Capability
  intro: >-
    More than 20 years of manufacturing experience connects early product
    thinking with the engineering and production disciplines needed to launch.
  items:
    - { icon: design, title: Product Incubation, desc: 'Turn rough ideas and simple sketches into practical product directions and development briefs.' }
    - { icon: id-design, title: Industrial & Mechanical Design, desc: 'Develop appearance, ergonomics, structure, materials, and design-for-manufacture together.' }
    - { icon: electronics, title: Electronics Engineering, desc: 'Support circuit design, PCBA development, embedded firmware, and complete device integration.' }
    - { icon: sampling, title: Prototyping & Validation, desc: 'Use prototypes, simulations, and pre-production samples to reduce physical rework before tooling.' }
    - { icon: mold, title: Tooling & Mass Production, desc: 'Move through mold development, test shots, pilot runs, assembly, and controlled volume production.' }
    - { icon: logistics, title: Quality & Global Delivery, desc: 'Identify risks early, verify products through production, and coordinate export and worldwide delivery.' }
  note: >-
    One accountable team connects each stage, while a diversified supply chain
    supports mixed materials, electronics, tooling, and final assembly.

process:
  id: process
  eyebrow: How we work
  heading: A clear six-stage path from brief to delivery
  intro: >-
    The homepage shows the detailed ten-step execution flow. Here it is grouped
    into six decision stages so project owners can see what is reviewed and
    approved before the next commitment.
  steps:
    - { title: Brief & Feasibility, desc: 'Align the product idea, target market, requirements, compliance needs, target cost, and schedule.' }
    - { title: Product & Engineering Design, desc: 'Develop appearance, mechanical structure, circuit design, material choices, and initial cost direction.' }
    - { title: Prototype & Validation, desc: 'Review functional prototypes and simulations, then confirm fit, function, and key risks before tooling.' }
    - { title: Tooling & First Articles, desc: 'Build molds and fixtures, evaluate test shots, and close design-for-manufacture issues.' }
    - { title: Pilot & Mass Production, desc: 'Validate the production process in a pilot run before controlled PCBA, assembly, and volume output.' }
    - { title: Quality Verification & Delivery, desc: 'Inspect throughout production, complete final verification, pack, document, and coordinate global shipment.' }

whyUs:
  id: why-us
  eyebrow: Why choose us
  heading: Engineering depth with global delivery reach
  intro: >-
    The same team that develops the product stays accountable through
    production, quality verification, and shipment.
  reasons:
    - { icon: experience, stat: '20+', label: Years of Experience, desc: 'OEM manufacturing experience since 2004, from concepts to shipment-ready products.' }
    - { icon: engineer, stat: '40+', label: Engineers, desc: 'Product, mechanical, electronics, tooling, and production expertise within one delivery team.' }
    - { icon: production, stat: '5000+', label: m² Facility, desc: 'Engineering, tooling, production, assembly, and quality capability in Dongguan.' }
    - { icon: logistics, stat: '40+', label: Countries, desc: 'International trade and delivery experience across major global markets.' }
    - { icon: quality, label: Pre-QC Risk Control, desc: 'Identify tooling, production, and assembly risks before final inspection and mass delivery.' }
    - { icon: manager, label: One Accountable Team, desc: 'Coordinate product development, sourcing, engineering, manufacturing, and logistics through one working relationship.' }

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
    Our engineering team will review your details and get back to you within 24
    hours.

# Real factory-scene video provided by the client (替换视频.zip / OEM.mp4),
# compressed to a muted, web-optimized mp4 and served from public/media. The
# poster shows until the muted autoplay loop starts.
factoryVideo:
  src: /media/oem-factory.mp4
  poster: /media/factory-oem.webp
  posterWidth: 1228
  posterHeight: 718
  caption: Inside our Dongguan engineering and production facility
---

<!--
en-US content for the OEM Development page. Copy this file to another locale
(e.g. zh-CN.md) and translate the frontmatter to localize the page.
-->
