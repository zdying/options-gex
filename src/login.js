const fs = require('fs');
const axios = require('axios');

// curl 'https://accounts.benzinga.com/api/v1/account/login/?include_layout_list=true&include_perms=true' \
// -H 'accept: application/json' \
// -H 'accept-language: zh-CN,zh;q=0.9,en;q=0.8' \
// -H 'cache-control: no-cache' \
// -H 'content-type: application/json' \
// -H 'origin: https://www.benzinga.com' \
// -H 'pragma: no-cache' \
// -H 'priority: u=1, i' \
// -H 'referer: https://www.benzinga.com/' \
// -H 'sec-ch-ua: "Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"' \
// -H 'sec-ch-ua-mobile: ?0' \
// -H 'sec-ch-ua-platform: "Linux"' \
// -H 'sec-fetch-dest: empty' \
// -H 'sec-fetch-mode: cors' \
// -H 'sec-fetch-site: same-site' \
// -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' \
// --data - raw '{"email":"goole@maildrop.cc","password":"Googleapple123"}'

module.exports = {
  login: async function (email, password) {
    try {
      const response = await axios({
        url: 'https://accounts.benzinga.com/api/v1/account/login/?include_layout_list=true&include_perms=true',
        method: 'POST',
        headers: {
          "accept": "application/json",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "cache-control": "no-cache",
          "content-type": "application/json",
          "origin": "https://www.benzinga.com",
          "pragma": "no-cache",
          "priority": "u=1, i",
          "referer": "https://www.benzinga.com/",
          "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": "\"Linux\"",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
        },
        data: JSON.stringify({ email, password })
      });
      return response.data;
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  }
};


if (require.main === module) {
  // Example usage:
  const email = 'goole@maildrop.cc';
  const password = 'Googleapple123';
  module.exports.login(email, password).then(data => {
    console.log('Login successful:', data);
    console.log('Access token:', data.key);
    fs.writeFileSync(__dirname + '/benzinga_token.txt', `benzinga_token=${data.key}`, 'utf-8');
  }).catch(error => {
    console.error('Login failed:', error);
  });
}