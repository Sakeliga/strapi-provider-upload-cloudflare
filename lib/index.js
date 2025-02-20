'use strict';

/**
 * Module dependencies
 */

/* eslint-disable no-unused-vars */
// Public node modules.
const axios = require("axios");
const FormData = require("form-data");
const { Readable } = require('stream');
const sharp = require('sharp');
var tus = require('tus-js-client');

module.exports = {
  init(config) {
    const accountId = config.accountId;
    const apiKey = config.apiKey;
    const variant = config.variant;
    const optimise = config.optimise;
    const streamCustomerSubdomain = config.streamCustomerSubdomain;
    return {
      upload(file) {
        const videoFormats = [".mp4", ".mkv", ".webm", ".mp3", ".avi"];

        // If file is in video format, upload to cloudflare stream using tus
        if (videoFormats.includes(file.ext)) {
          return new Promise((resolve, reject) => {
            var options = {
              endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
              chunkSize: 50 * 1024 * 1024,
              metadata: {
                filename: `${file.hash}${file.ext}`,
                filetype: file.mime,
                defaulttimestamppct: 0.5,
                downloadable: true,
              },
              uploadSize: Buffer.byteLength(file.buffer),
              onError: function (error) {
                reject(error);
              },
              onSuccess: function () {
                console.log('Upload finished');
                resolve(file);
              },
              onAfterResponse: function (req, res) {
                return new Promise(resolve => {
                  var mediaIdHeader = res.getHeader('stream-media-id');
                  if (mediaIdHeader) {
                    file.url = `https://${streamCustomerSubdomain}/${mediaIdHeader}/downloads/default.mp4`;
                    file.provider_metadata = {
                      public_id: mediaIdHeader,
                      source: "stream"
                    }
                  }
                  resolve();
                });
              },
            };

            var upload = new tus.Upload(file.buffer, options);
            upload.start();
          }).then((file) => {
            return file;
          })

        }
        else {
          const stream = new Readable({
            read() {
              this.push(file.buffer);
              this.push(null);
            },
          })
          var data = new FormData();
          data.append("file", stream, `${file.hash}${file.ext}`);
          const headers = data.getHeaders();
          return axios({
            method: "POST",
            url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              ...headers,
            },
            data: data,
          }).then((response) => {
            const result = response.data.result;
            const filename = result.filename;
            const split = filename.split('.');
            const type = split.length > 0 ? split[split.length - 1] : '';
            let url = result.variants[0];
            if (variant && variant.length > 0) {
              url = `${url.split('/').slice(0, -1).join('/')}/${variant}`;
            }
            file.url = url;
            file.provider_metadata = {
              public_id: result.id,
              resource_type: type,
            };

            const optimisableExtensions = ['.jpg', '.png', '.jpeg'];

            // Convert file to webp, upload webp and attach webp details to file.provider_metadata
            if (
              optimise
              && (optimise === 'true' || optimise === 'True')
              && optimisableExtensions.includes(file.ext)
            ) {
              return sharp(file.buffer)
                .clone()
                .webp({ quality: 100 })
                .toBuffer()
                .then((webpData) => {

                  const webpStream = new Readable({
                    read() {
                      this.push(webpData);
                      this.push(null);
                    },
                  })

                  var formData = new FormData();
                  formData.append("file", webpStream, `${file.hash}${'.webp'}`);

                  return axios({
                    method: "POST",
                    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
                    headers: {
                      Authorization: `Bearer ${apiKey}`,
                      'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`
                    },
                    data: formData,
                  }).then((response) => {
                    const result = response.data.result;
                    const filename = result.filename;
                    const split = filename.split('.');
                    const type = split.length > 0 ? split[split.length - 1] : '';
                    let url = result.variants[0];
                    if (variant && variant.length > 0) {
                      url = `${url.split('/').slice(0, -1).join('/')}/${variant}`;
                    }

                    file.provider_metadata.webp = {
                      url: url,
                      public_id: result.id,
                      resource_type: type,
                    };

                    return file;
                  });
                });
            }
            else {
              return file;
            }
          }).catch((e) => console.log(e));
        }
      },
      delete(file) {
        if (file?.provider_metadata?.source === "stream") {
          const { public_id } = file.provider_metadata;
          return axios({
            method: "DELETE",
            url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${public_id}`,
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
          }).catch((error) => {
            if (error.status === 404) {
              console.log(`Video not found on Cloudflare: ${error.message}`);
            } else {
              throw new Error(`Error with deleting video on Cloudflare: ${error.message}`);
            }
          });
        }
        else {
          const { public_id } = file.provider_metadata;
          return axios({
            method: "DELETE",
            url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1/${public_id}`,
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
          }).then(() => {
            if (file.provider_metadata.webp && file.provider_metadata.webp.public_id) {
              const { public_id } = file.provider_metadata.webp;
              return axios({
                method: "DELETE",
                url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1/${public_id}`,
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                },
              }).catch((error) => {
                if (error.status === 404) {
                  console.log(`Webp image not found on Cloudflare: ${error.message}`);
                } else {
                  throw new Error(`Error with deleting webp on Cloudflare: ${error.message}`);
                }
              });
            }
          }).catch((error) => {
            if (error.status === 404) {
              console.log(`Image not found on Cloudflare: ${error.message}`);
            } else {
              throw new Error(`Error with deleting on Cloudflare: ${error.message}`);
            }
          });
        }
      },
    };
  },
};
