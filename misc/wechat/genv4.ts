const path = "./resultv4.json";
const file = Bun.file(path);

const text = await file.text();

const data = JSON.parse(text);

console.log(data);

let ips: any = {};

for (const [host, result] of Object.entries(data)) {
  console.log(`Host: ${host}`);
  for (const item of result.list) {
    console.log(`  Node: ${item.node_name} - ${item.origin_ip}`);
    // if has records
    if (item.records) {
      for (const record of item.records) {
        console.log(`    ${record.name} - ${record.value}`);
        // if is ipv4
        if (record.value.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
          if (!ips[record.value]) {
            ips[record.value] = [];
          }
          ips[record.value].push(
            `${host} - ${item.node_name}(${item.origin_ip})`
          );
        }
      }
    }
  }
}

console.log(ips);

const sortedIps = Object.keys(ips)
  .sort((a, b) => {
    const aParts = a.split(".");
    const bParts = b.split(".");
    for (let i = 0; i < 4; i++) {
      const diff = parseInt(aParts[i]) - parseInt(bParts[i]);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  })
  .reduce((obj, key) => {
    obj[key] = ips[key];
    return obj;
  }, {});

const outputPath = "wechat-ipv4.list";

let output = "";
for (const [ip, hosts] of Object.entries(sortedIps)) {
  output += `IP-CIDR,${ip}/32\n`;
  for (const host of hosts) {
    output += `\t # ${host}\n`;
  }
}

console.log(output);
await Bun.write(outputPath, output);
