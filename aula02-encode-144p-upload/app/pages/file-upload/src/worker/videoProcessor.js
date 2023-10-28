export default class VideoProcessor {
  #mp4Demuxer;
  #webMWriter;
  #service;
  #buffers = []

  /**
   *
   * @param {object} options
   *  @param { import('./mp4Demuxer.js').default } options.mp4Demuxer
   *  @param { import('./../deps/webm-writer2.js').default } options.webMWriter
   *  @param { import('./service.js').default } options.service
   */
  constructor({ mp4Demuxer, webMWriter, service }) {
    this.#mp4Demuxer = mp4Demuxer;
    this.#webMWriter = webMWriter;
    this.#service = service;
  }

  /**
   *
   * @param {*} stream
   * @returns {ReadableStream}
   */
  mp4Decoder(stream) {
    return new ReadableStream({
      start: async (controller) => {
        const decoder = new VideoDecoder({
          /**
           *
           * @param {VideoFrame} frame
           */
          output(frame) {
            controller.enqueue(frame);
          },
          error(e) {
            console.error("error at mp4Decoder", e);
            controller.error(e);
          },
        });

        return this.#mp4Demuxer
          .run(stream, {
            async onConfig(config) {
              // has some error about
              // const { supported } = await VideoDecoder.isConfigSupported(
              //   config
              // );

              // if (!supported) {
              //   console.error(
              //     "mp4Muxer VideoDecoder config not supported!",
              //     config
              //   );
              //   controller.close()
              //   return;
              // }

              decoder.configure(config);
            },
            /**
             *
             * @param {EncodedVideoChunk} chunk
             */
            onChunk(chunk) {
              decoder.decode(chunk);
            },
          })
          // .then(() => {
          //   setTimeout(() => {
          //     controller.close();
          //   }, 1000);
          // });
      },
    });
  }

  encode144p(encoderConfig) {
    let _encode;
    
    const readable = new ReadableStream({
      start: async (controller) => {
        const { supported } = await VideoEncoder.isConfigSupported(encoderConfig)

        if(!supported) {
          const message = 'encode144p VideoEncoder config not supported!'
          console.error(
            message,
            encoderConfig
          );
          controller.error(message)
          return;
        }

        _encode = new VideoEncoder({
          /**
           * 
           * @param {EncodedVideoChunk} frame 
           * @param {EncodedVideoChunkMetadata} config 
           */
          output: (frame, config) => {
            if(config.decoderConfig) {
              const decoderConfig = {
                type: 'config',
                config: config.decoderConfig
              }
              // estamos mando enfileirando tudo no controller e passando para frente
              controller.enqueue(decoderConfig)
            }
            controller.enqueue(frame)
          },
          error: (err) => {
            console.error('VideoEncoder 114p', err)
            controller.error(err)
          }
        })

        
        await _encode.configure(encoderConfig)
        
      }
    })

    const writable = new WritableStream({
      async write(frame) {
        _encode.encode(frame)
        frame.close()
      }
    })

    // Duplex listen data and write data
    return {
      readable,
      writable
    }
  }

  renderDecodedFramesAndGetEncodedChunks(renderFrame) {
    let _decoder;
    return new TransformStream({
      start: (controller) => {
        _decoder = new VideoDecoder({
          output(frame) {
            renderFrame(frame)
          },
          error(err) {
            console.error('error at renderFrames', e)
            controller.error(err)
          }
        })
      },
      /**
       * 
       * @param {EncodedVideoChunk} encodeChunk 
       * @param {TransformStreamDefaultController} controller 
       */
      async transform(encodeChunk, controller) {

        // config da funcao encode144p.readable._encode.output.decoderConfig = 'config'
        if(encodeChunk.type === 'config') {
          await _decoder.configure(encodeChunk.config)
          return;
        }
        _decoder.decode(encodeChunk)

        // need the encoded version to use webM

        controller.enqueue(encodeChunk)
      }
    })
  }

  transformIntoWebM() {
    const writable = new WritableStream({
      write: (chunk) => {
        this.#webMWriter.addFrame(chunk)
      },
      close() {
        //
      }
    })

    return {
      readable: this.#webMWriter.getStream(),
      writable
    }
  }

  upload(fileName, resolution, type) {
    const chunks = []
    let byteCount = 0
    let segmentCount = 0

    const triggerUpload = async (chunks) => {
      const blob = new Blob(
        chunks, { type: 'video/webm' }
      )

      await this.#service.uploadFile({
        fileName: `${fileName}-${resolution}.${++segmentCount}.${type}`,
        fileBuffer: blob
      })
      // gamb to clean array, remove all elements
      chunks.length = 0
      byteCount = 0
    }


    return new WritableStream({
      /**
       * 
       * @param {object} options 
       * @param {Uint8Array} options.data 
       */
      async write({ data }) {
        chunks.push(data)
        byteCount += data.byteLength
        // if is less than 10MB not upload
        if (byteCount <= 10e6) return

        await triggerUpload(chunks)

      },
      // neste processo pode ser que o dado seja menor que 10mb, se for assim os dados não seriam enviados
      // para que os dados restantes sejam enviados aproveitamos o close para pegar todo o restante que houver
      // e faz o envio
      async close() {
        if(!chunks.length === 0) return;
        await triggerUpload(chunks)
      }
    })
  }

  async start({ file, encoderConfig, renderFrame, sendMessage }) {
    const stream = file.stream();
    const fileName = file.name.split("/").pop().replace(".mp4", "");
    await this.mp4Decoder(stream)
      // // pipeThrough receive but WritableStream and ReadableStream
      .pipeThrough(this.encode144p(encoderConfig))
      .pipeThrough(this.renderDecodedFramesAndGetEncodedChunks(renderFrame))
      .pipeThrough(this.transformIntoWebM())
      // This code about is to make download from media Only debug because is not good add it in memory...
      // .pipeThrough(
      //   new TransformStream({
      //     // to see the properties use the debbuger in browser, with it cans view the properties and his types
      //     transform: ({ data, position }, controller) => {
      //       this.#buffers.push(data)
      //       controller.enqueue(data)
      //     },
      //     // when finish the process
      //     flush: () => {
      //       // debugger

      //       // Send message about file with buffers to download encoded file webM
      //       // sendMessage({
      //       //   status: 'done',
      //       //   buffers: this.#buffers,
      //       //   fileName: fileName.concat('-144p.webm')
      //       // })
      //       sendMessage({
      //         status: 'done',
      //       })
      //     }
      //   })
      // )
    // // pipeTo receive only WritableStream
    .pipeTo(this.upload(fileName, '144p', 'webm'))
    // .pipeTo(
    //   new WritableStream({
    //     write: (frame) => {
    //       // renderFrame(frame);
    //     },
    //   })
    // );

    sendMessage({
      status: 'done'
    })
  }
}
