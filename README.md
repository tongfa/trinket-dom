# Trinkit

A bare bones UI framework intended to expose developer to browser APIs and DOM manipulation more so
than other UI frameworks.

Goals:

* Make coding fun like it was in 1984!
* Zero dependencies
* Use of compiler / build system / minification is discouraged
* editable source is encouraged
* creating archival quality apps that always work from the source level is possible
* Framework syntax is consistently marked providing a clear indication of browser native code vs. framework code. (currently uses `$` prefix)
* framework maintenance is greatly reduced over long run because of lack of dependencies
* Explicit naming is preferred over syntax brevity

While this project works, it isn't well optimized yet and therefore is currently useful for smaller projects. I would think other modern frameworks would be more performant.

## Syntax

### Creating a component

A component is defined by using trinkit's `$component` function to define the component's behavior.  It's required to have a `name` which identifies the HTML tag that this component is associated with.

#### using a template

Currently components require a template which is defined in a browser native template element.  By default the component's name will be matched to the template's `id` attribute in order to identify
the correct template. Alternatively the component can use `templateId` to identify the template as well.


#### example component definition

```
    <script>
        $component({
            name: 'tag-name',
            parameters: ['attributeParameter', 'attributeParameter2'],
            data: {
                fire() { /* function defined here */ },
                targetName: 'aSimpleStringValue',
            }
        })
    </script>
    <template id="test-status">
        <div>
            <span $if="status === 'success'">passed</span>
            <span $else-if="status === 'failure'">failed</span>
            <span $else>still running</span>
        </div>
    </template>
```

And this example's usage might look like:

```
 <tag-name
   attributeProperty="aValueDefinedAsString"
   $attr:attributeProperty2="'aValueFromEvaluatedJavascriptExpression'"
   $event:click="fire()"
   >
```
