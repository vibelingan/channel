---
locale: en-US

meta:
  title: OEM Development
  description: >-
    One-stop OEM development service — from product design and mold tooling to
    mass production, quality control, and global logistics.

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
