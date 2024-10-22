const KEY = "YOUR_API_KEY";
const getNodeList = async () => {
  const response = await fetch("https://api.boce.com/v3/node/list?key=" + KEY);
  const data = await response.json();
  // Example data:
  //   {
  //     "error_code": 0,
  //     "error": "",
  //     "data": {
  //         "list": [
  //             {
  //                 "id": 6,
  //                 "node_name": "河北",
  //                 "isp_name": "电信",
  //                 "isp_code": 100017
  //             }
  //         ]
  //     }
  // }
  return data.data.list;
};

const nodeList = await getNodeList();
const nodeListString = nodeList.map((node: any) => node.id).join(",");

const targetHost = [
  "szminorshort.weixin.qq.com",
  "szlong.weixin.qq.com",
  "shextshort.weixin.qq.com",
  "short.weixin.qq.com",
  "mllong.weixin.qq.com",
  "szextshort.weixin.qq.com",
  "szaxshort.weixin.qq.com",
  "quic.weixin.qq.com",
  "szquic.weixin.qq.com",
  "mlshort.mixpay.wechatpay.cn",
  "udns.weixin.qq.com",
  "short.mixpay.wechatpay.cn",
  "mlshort.snspay.wechatpay.cn",
  "szshort.mixpay.wechatpay.cn",
  "shshort.snspay.wechatpay.cn",
  "mlextshort.weixin.qq.com",
  "short.pay.weixin.qq.com",
  "shquic.weixin.qq.com",
  "long.weixin.qq.com",
  "mlminorshort.weixin.qq.com",
  "mlshort.pay.weixin.qq.com",
  "shshort.pay.weixin.qq.com",
  "shshort.mixpay.wechatpay.cn",
  "mlaxshort.weixin.qq.com",
  "mlshort.weixin.qq.com",
  "szdisas.weixin.qq.com",
  "mldisas.weixin.qq.com",
  "shdisas.weixin.qq.com",
  "minorshort.weixin.qq.com",
  "szshort.weixin.qq.com",
  "szshort.pay.weixin.qq.com",
  "extshort.weixin.qq.com",
  "axshort.weixin.qq.com",
  "short.snspay.wechatpay.cn",
  "szshort.snspay.wechatpay.cn",
  "mlquic.weixin.qq.com",
  "hkshort.pay.weixin.qq.com",
  "hkshort.weixin.qq.com",
  "hklong.weixin.qq.com",
  "sgminorshort.wechat.com",
  "sgshort.pay.wechat.com",
  "hkshort.mixpay.wechatpay.cn",
  "sgquic.wechat.com",
  "hkquic.weixin.qq.com",
  "hkshort.snspay.wechatpay.cn",
  "sgshort.snspay.wechat.com",
  "sgshort.wechat.com",
  "hkaxshort.weixin.qq.com",
  "hkextshort.weixin.qq.com",
  "dns.wechat.com",
  "sglong.wechat.com",
  "hkshort6.weixin.qq.com",
  "hkdisas.weixin.qq.com",
  "sgaxshort.wechat.com",
  "hkminorshort.weixin.qq.com",
  "sgshort.mixpay.wechat.com",
  "mmsns.hk.wechat.com",
  "szsupport.weixin.qq.com",
  "api.weixin.qq.com",
  "wxapp.tc.qq.com",
  "mmsns.qpic.cn",
  "c6.y.qq.com",
  "shmmsns.qpic.cn",
  "szmmsns.qpic.cn",
  "mlsupport.weixin.qq.com",
  "weixin110.qq.com",
  "shp.qlogo.cn",
  "wx.qlogo.cn",
  "weixin.qq.com",
  "vweixinf.tc.qq.com",
  "support.weixin.qq.com",
  "weixinc2c.tc.qq.com",
  "hksupport.weixin.qq.com",
  "wxsnsdythumb.wxs.qq.com",
  "mp.weixin.qq.com",
  "open.weixin.qq.com",
  "wxsnsdy.wxs.qq.com",
];

console.log("nodeListString", nodeListString);

let result: any = {};
for (const host of targetHost) {
  const response = await fetch(
    "https://api.boce.com/v3/task/create/dig?key=" +
      KEY +
      "&host=" +
      host +
      "&node_ids=" +
      nodeListString
  );
  const data = await response.json();
  // Example data:
  //   {
  //     "error_code": 0,
  //     "data": {
  //         "id": "LxiB1jZPNiGZbvSYxBoVNEAfR8DhZaQ"
  //     },
  //     "error": "错误信息",
  // }
  // for 10s in 2 minutes
  const id = data.data.id;
  console.log(`Task Created: ${id} - ${host}`);
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const response = await fetch(
      "https://api.boce.com/v3/task/dig/" + id + "?key=" + KEY
    );
    const data = await response.json();
    // Example data:
    //   {
    //     "done": true,
    //     "id": "751854daeb70d4b2a933f293861746ea",
    //     "list": [
    //         {
    //             "node_id": 6,
    //             "node_name": "河北电信",
    //             "host": "www.baidu.com",
    //             "origin_ip": "106.8.158.251",
    //             "report_source": "www.baidu.com.\t\t0\tIN\tA\t182.61.200.6\nwww.baidu.com.\t\t0\tIN\tA\t182.61.200.7\n;; Query time: 23 msec\n;; SERVER: 127.0.0.1#53(127.0.0.1)\n;; WHEN: Thu Dec 24 06:35:20 2020\n;; MSG SIZE  rcvd: 316\n",
    //             "session_id": "D4EE07120704",
    //             "error_code": 0,
    //             "error": "",
    //             "time_id": "751854daeb70d4b2a933f293861746ea",
    //             "query_time": 23,
    //             "use_dns": [
    //                 "10.236.1.103",
    //                 "10.236.1.104"
    //             ],
    //             "records": [
    //                 {
    //                     "ttl": 0,
    //                     "name": "www.baidu.com",
    //                     "type": "A",
    //                     "value": "182.61.200.6",
    //                     "q_time": 23,
    //                     "ip_region": "中国北京北京",
    //                     "ip_isp": "电信"
    //                 }
    //             ]
    //         }
    //     ],
    //     "max_node": 1
    // }
    if (data.done) {
      result[host] = data;
      console.log("Task Done:", data.list.length);
      break;
    }
  }
}

console.log(result);

const path = "./resultv4.json";
await Bun.write(path, JSON.stringify(result, null, 2));
