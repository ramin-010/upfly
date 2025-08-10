const sharp = require('sharp');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsPromise = fs.promises;

const uploadAndWebify = (options = {}) => {
  const {
    fields = {},
    outputDir = './uploads',
    limit = 5 * 1024 * 1024 
  } = options;

  if(typeof fields !== 'object' || fields === null || Array.isArray(fields) ){
    throw new TypeError("`fields` option must be a plain object with field configurations.");
   }

  if(typeof outputDir !== 'string'){
    throw new TypeError("`outputDir` option must be a string.");
  }

  for (const [fieldname, config] of Object.entries(fields)) {
    if (typeof config !== 'object' || config === null) {
      throw new TypeError(`Field config for '${fieldname}' must be an object.`);
    }

    if (config.output && !['disk', 'memory'].includes(config.output)) {
      throw new RangeError(`Field '${fieldname}' has invalid output value '${config.output}'. Allowed: 'disk', 'memory'.`);
    }

    if (config.quality !== undefined) {
      if (typeof config.quality !== 'number' || config.quality < 1 || config.quality > 100) {
        throw new RangeError(`Field '${fieldname}' quality must be a number between 1 and 100.`);
      }
    }

    if (config.format !== undefined && typeof config.format !== 'string') {
      throw new TypeError(`Field '${fieldname}' format must be a string.`);
    }
  }

  if (typeof limit !== 'number' || limit <= 0) {
    throw new TypeError("`limits.fileSize` must be a positive number (bytes).");
  }

  const allowedFieldNames = new Set(Object.keys(fields));

  // Use fileFilter to avoid buffering unknown fields at all (most memory/CPU efficient)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limit },
    fileFilter: (req, file, cb) => {
      if (!allowedFieldNames.has(file.fieldname)) return cb(null, false);
      cb(null, true);
    }
  }).any();

  return async (req, res, next) => {
    upload(req, res, async (uploadErr) => {
      if (uploadErr) return next(uploadErr);
      if (!req.files) return next();

      // convert array to grouped object
      if (Array.isArray(req.files)) {
        const grouped = {};
        for (const file of req.files) {
          if (!grouped[file.fieldname]) grouped[file.fieldname] = [];
          grouped[file.fieldname].push(file);
        }
        req.files = grouped;
      }

      try {
        for (const fieldname in req.files) {
          const config = fields[fieldname] || {};
          const output = config.output || 'memory';
          const format = config.format || 'webp';
          const quality = config.quality || 80;


          req.files[fieldname] = await Promise.all(
            req.files[fieldname].map(async (file) => {
              
              if (!file.mimetype || !file.mimetype.startsWith("image")) {
                const normalizedOutputDir = ensureServerRootDir(outputDir);
                return output === 'disk'
                  ? saveRawFileToDisk(file, normalizedOutputDir)
                  : file;
              }
              try{
                const buffer = await convertImage(file.buffer, format, quality);
                if (output === 'disk') {
                  const normalizedOutputDir = ensureServerRootDir(outputDir);
                  return saveConvertedToDisk(buffer, file, normalizedOutputDir, format);
                } else {
                  return {
                    ...file,
                    buffer,
                    mimetype: `image/${format.toLowerCase()}`
                  };
                }
              }catch(err){
                if (output === 'disk') {
                  console.error(
                    `File saved with original format. Sharp failed for ${file.originalname}: ${err.message || 'Unknown error'}`
                  );                  
                  const normalizedOutputDir = ensureServerRootDir(outputDir);
                  return saveRawFileToDisk(file, normalizedOutputDir);
                } else {
                  console.error(
                    `Sharp failed for ${file.originalname}: ${err.message || 'Unknown error'}`
                  );
                  return file;
                }
              }
            })
          );
        }
        next();
      } catch (err) {
        next(err);
      }
    });
  };
};

//# Webify -(only handle the conversion)
const webify = (options = {}) =>{
  const {
    fields = {},
  } = options

  return async(req, res, next) =>{
      try{
        if(req.file && req.file.mimetype.startsWith('image')){
          const config = fields[req.file.fieldname] || {};
          const quality = config.quality || 80;
          const format = config.format || 'webp'

          try{
            const buffer = await convertImage(req.file.buffer, format, quality);
            req.file = {
              ...req.file,
              buffer : buffer,
              mimetype : `image/${format.toLowerCase()}`
            }
          }catch(err){
            console.error(
              `Sharp failed for ${req.file.originalname}: ${err.message || 'Unknown error'}`
            );          
          }
        }
          if (req.files && typeof req.files === 'object') {
            for(const fieldname in req.files){
              if(!req.files[fieldname] || Object.keys(req.files).length === 0) continue;
              const config = fields[fieldname] || {};
              const format = config.format || 'webp';
              const quality = config.quality || 80;
            
                
              req.files[fieldname] = await Promise.all(
                  req.files[fieldname].map(async(file, idx) => {

                      if(!file.mimetype || !file.mimetype.startsWith('image')){
                          return file;
                      }

                      try{
                        const buffer = await convertImage(file.buffer, format, quality);

                        return {
                          ...file,
                          buffer : buffer,
                          mimetype : `image/${format.toLowerCase()}`
                        }
                      }catch(err){
                        console.error(
                          `Sharp failed for ${file.originalname}: ${err.message || 'Unknown error'}`
                        );
                        return file;
                      }
                  })
              )
            }
          }
        next();
      }catch(err){
          next(err)
      }
  }
}

// safer conversion for production
const convertImage = async (inputBuffer, format, quality) => {
  try {
    const buffer = await sharp(inputBuffer)
      .toFormat(format, { quality })
      .toBuffer();

    const metadata = await sharp(buffer).metadata();
    if (metadata.format !== format.toLowerCase()) {
      throw new Error(`Expected format ${format}, got ${metadata.format}`);
    }

    if (process.env.NODE_ENV && process.env.NODE_ENV.toLowerCase() === 'development') {
      console.log(
        `Converted image to \x1b[32m${format}\x1b[0m with quality \x1b[32m${quality}\x1b[0m: ` +
        `original size \x1b[32m${(inputBuffer.length / (1024 * 1024)).toFixed(2)} MB\x1b[0m, ` +
        `converted size \x1b[32m${(buffer.length / (1024 * 1024)).toFixed(2)} MB\x1b[0m`
      );
    }
    
    return buffer;
  } catch (err) {
    throw err; 
  }
};


const ensureServerRootDir = (targetPath) =>{
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new TypeError('`outputDir` must be a non-empty string path.');
  }

  const input = targetPath.trim();
  const isWindowsDriveAbs = /^[a-zA-Z]:[\\/]/.test(input);
  const looksRootedBySlash = /^[\\/]/.test(input);

  let resolved;
  if (isWindowsDriveAbs) {
    resolved = input;
    
  } else if (looksRootedBySlash) {
    // Treat '/uploads' or '\uploads' as project-root relative
    const stripped = input.replace(/^[/\\]+/, '');
    resolved = path.resolve(process.cwd(), stripped);

    if (process.env.NODE_ENV !== 'production' && !ensureServerRootDir._warned) {
      // Colors
      const yellow = '\x1b[33m';
      const cyan = '\x1b[36m';
      const green = '\x1b[32m';
      const magenta = '\x1b[35m';
      const reset = '\x1b[0m';

      console.warn(
        `${yellow}upfly notice:${reset} outputDir ${cyan}'${input}'${reset} looked like a root path.\n` +
        `→ Resolved under project root as: ${green}${resolved}${reset}\n` +
        `If you really want to write outside the project, use an explicit absolute path:\n` +
        `  Windows: ${cyan}C:\\\\data\\\\uploads${reset}  or  ${cyan}D:/data/uploads${reset}\n` +
        `  Linux/Mac: ${cyan}/var/data/uploads${reset}`
      );
      ensureServerRootDir._warned = true;
    }
  } else {
    // Regular relative path
    resolved = path.resolve(process.cwd(), input);
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

const saveRawFileToDisk = async(file, outputDir) => {
  let {ext} = path.parse(file.originalname);
  ext = ext ? ext.slice(1).toLowerCase() : 'bin';
  const format = ext || 'bin';

  const filename = generateFileName(file, format)  //#generating a safe name
  const filePath = path.join(outputDir, filename);

  await fsPromise.writeFile(filePath, file.buffer)
  return {
    ...file,
    buffer: undefined,
    path: filePath,
    filename: filename
  };
};

const saveConvertedToDisk = async(buffer, file, outputDir, format) => {
  const fileName = generateFileName(file, format.toLowerCase());
  const filePath = path.join(outputDir, fileName);

  await fsPromise.writeFile(filePath, buffer); 

  return {
    ...file,
    buffer: undefined,
    filename: fileName,
    path: filePath,
    mimetype: `image/${format.toLowerCase()}`
  };
};

const slugify = (originalBase) =>{
  return originalBase
    .toString()
    .trim()
    .toLowerCase() 
    .replace(/[^a-z0-9]+/g, '-')   // Replace any sequence of non-alphanumeric chars with a single hyphen
    .replace(/^-+|-+$/g, ''); // Trim leading/trailing hyphens
}

const generateFileName = (file, format) =>{
  const originalname = file?.originalname;
  const fieldname = file?.fieldname;
  const originalBase = path.parse(originalname).name ;
  const slugifiedBase = slugify(originalBase);

  let parts = [];
  if (
    file.mimetype &&
    file.mimetype.startsWith('image') &&
    typeof fieldname === 'string' &&
    fieldname.trim()
  ) {
    parts.push(fieldname.trim());
  }
  if(slugifiedBase) parts.push(slugifiedBase);
  const uniqueSuffix = `${Math.random().toString(16).slice(2, 6)}`;
  parts.push(uniqueSuffix);

  const finalName = parts.join('-');
  return `${finalName}.${format}`
}



module.exports = {
  upflyUpload: uploadAndWebify,
  upflyConvert: webify
};
