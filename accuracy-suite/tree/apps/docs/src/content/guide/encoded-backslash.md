# A diagram whose folder separator was encoded

A converter that percent-encodes what it does not trust wrote the separator as %5C, which a
renderer passes through and a browser keeps as written.

![The diagram](/img%5Cdiagram.png)
