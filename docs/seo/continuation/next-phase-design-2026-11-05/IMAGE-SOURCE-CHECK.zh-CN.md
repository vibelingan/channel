# 三张失败商品图：商品与原图核对

2026-11-05，只读核对。三个来源 PNG 都能完整下载；SHA-256 与网站图像记录一致。三张图也都存在于相应商品当前批准图库中。网站图片地址返回的 400 均明确写“HTTP response body exceeds ... 6MB”。

**结论：目前没有证据说明供应商原图失效或同步损坏，主要问题在我们用云函数返回整张图的方式。** 原图大约 4.9–5.1 百万字节，转换成 Base64 后约 6.6–6.7 百万字节；这是膨胀量估算，平台具体在哪层计数仍需实施时用边界用例确认。不要把缺图责任直接归给供应商。

| 商品 ID | 网站中的完整名称 | 同步来源商品编号 | 原图 / 网站图片 |
|---|---|---|---|
| `bbdc923d-7103-40e2-a8ae-93e10bc27f58` | SH1 New 2021 Original All Phone Earphone for Skype With Microphone Wired Headphone Computer Headset | `AAHiBBhgAOVTpOqZBhj1H7Es` | [Alibaba 原图](https://sc04.alicdn.com/kf/Sfb4701ec663c4bda8e77868cb9c2d0f45.png) · [网站图片](https://supplychainsai.com/api/images/4db8df016ac88396000781db489eb227) |
| `9504ba1c-247d-4864-a6ae-74b65da3d922` | Soyto HN8806 HiFi Headphones Immersive Sound for PC Mobile Factory Direct Fashion Versatile New Model Fone De Ouvido Auriculares | `AAFUBBhgAOVTpOKZBnRAim5X` | [Alibaba 原图](https://sc04.alicdn.com/kf/H27f1e5ea3e724468b43fbf2f74509a6fl.png) · [网站图片](https://supplychainsai.com/api/images/ea7765a56ab1dbea01d9b6924386c973) |
| `8df493d4-3e02-4f7c-a3a2-907c1639064d` | Wireless On Ear Headphones Foldable Stereo Headset for Mobile Phone PC with 5 Color Options | `AAEVBBhgAOVTpOKZBnRG5G05` | [Alibaba 原图](https://sc04.alicdn.com/kf/H57f6fd4d151240b2a7f3467d66217717f.png) · [网站图片](https://supplychainsai.com/api/images/31051309-b170-4ef2-a7f7-86c645fd3fad) |

| 商品简称 | 完整字节数 | PNG 宽高 | 原图 HTTP | 网站 HTTP |
|---|---:|---|---:|---:|
| SH1 | 5,021,685 | 3000 × 3000 | 200 | 400 |
| HN8806 | 4,943,448 | 2755 × 2755 | 200 | 400 |
| 折叠无线耳机 | 5,051,781 | 2048 × 2048 | 200 | 400 |

客户如要问供应商，可用上表定位，并问是否有适合网页的轻量版本；修复不依赖供应商先提供新图。这次仅验证完整字节、摘要、PNG 标识和尺寸，没有评审图片中的品牌或商业声明。

原始 GET 回执见 [source-and-taxonomy-probes.json](evidence/source-and-taxonomy-probes.json)，商品与来源的脱敏对应表见 [product-image-source-map.json](evidence/product-image-source-map.json)。没有把存储密钥、临时下载签名或完整私有商品记录放入仓库。
