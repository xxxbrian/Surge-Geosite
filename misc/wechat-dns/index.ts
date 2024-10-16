import { parseString } from "xml2js";

interface DomainInfo {
  name: string;
  ips: string[];
}

interface DNSInfo {
  domains: DomainInfo[];
  builtinIpList: string[];
  clientIp: string;
}

function parseDNSXML(xmlString: string): Promise<DNSInfo> {
  return new Promise((resolve, reject) => {
    parseString(xmlString, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      const dns = result.dns;
      const domains: DomainInfo[] = dns.domainlist[0].domain.map(
        (domain: any) => ({
          name: domain.$.name,
          ips: domain.ip.map((ip: string) => ip),
        })
      );

      const builtinIpList: string[] = dns.builtiniplist[0].ip;
      const clientIp: string = dns.clientip[0];

      resolve({
        domains,
        builtinIpList,
        clientIp,
      });
    });
  });
}

async function fetchAndParseDNS(): Promise<DNSInfo> {
  try {
    const response = await fetch(
      "https://dns.weixin.qq.com/cgi-bin/micromsg-bin/newgetdns",
      {
        method: "GET",
        headers: {},
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const xmlString = await response.text();
    return await parseDNSXML(xmlString);
  } catch (error) {
    console.error("Error fetching or parsing DNS XML:", error);
    throw error;
  }
}

fetchAndParseDNS()
  .then((dnsInfo) => {
    let result = "# WeChat DNS\n\n";
    result += "# Domain and IPs\n\n";
    for (const domain of dnsInfo.domains) {
      if (domain.name === "localhost") {
        continue;
      }

      result += `DOMAIN-SUFFIX,${domain.name}\n`;
      for (const ip of domain.ips) {
        result += `IP-CIDR,${ip}/32\n`;
      }
      result += "\n";
    }

    result += "# Built-in IPs\n\n";
    for (const ip of dnsInfo.builtinIpList) {
      result += `IP-CIDR,${ip}/32\n`;
    }

    result += "\n";
    result += "# Client IP: " + dnsInfo.clientIp + "\n";
    result += "# Generated at: " + new Date().toISOString() + "\n";
    console.log(result);
  })
  .catch((error) => {
    console.error("Error:", error);
  });
