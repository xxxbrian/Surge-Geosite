# Surge Geosite Ruleset

Geosite Ruleset Converter for Surge

This project utilizes Cloudflare Workers to **dynamically convert geosite data** from the [domain-list-community](https://github.com/v2fly/domain-list-community) project into **Surge's Ruleset format**. For instance, you can convert the geosite entry:
```
geosite: apple@cn
```
into a Surge-compatible Ruleset using the following URL:
```
https://surge.bojin.co/geosite/apple@cn
```
This conversion ensures real-time updates and compatibility with Surge configurations.

---

**Geosite Ruleset Index**

* JSON Format: `https://surge.bojin.co/geosite`

